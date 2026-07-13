import { useCallback, useEffect } from 'react'
import { useSnapshot } from 'valtio'

import { Annotation } from '@flow/reader/annotation'
import { Bookmark } from '@flow/reader/bookmark'
import { BookRecord } from '@flow/reader/db'
import { BookTab } from '@flow/reader/models'
import {
  toDropboxBookmarkFile,
  uploadBookmarks,
  uploadData,
} from '@flow/reader/sync'

import { useRemoteBookmarks, useRemoteBooks } from './useRemote'

export function useSync(tab: BookTab) {
  const { mutate } = useRemoteBooks()
  const { mutate: mutateRemoteBookmarks } = useRemoteBookmarks()
  const { location, book } = useSnapshot(tab)

  const id = tab.book.id

  const sync = useCallback(
    async (changes: Partial<BookRecord>) => {
      // to remove effect dependency `remoteBooks`
      mutate(
        (remoteBooks) => {
          if (remoteBooks) {
            const i = remoteBooks.findIndex((b) => b.id === id)
            if (i < 0) return remoteBooks

            remoteBooks[i] = {
              ...remoteBooks[i]!,
              ...changes,
            }

            uploadData(remoteBooks)

            return [...remoteBooks]
          }
        },
        { revalidate: false },
      )
    },
    [id, mutate],
  )

  useEffect(() => {
    sync({
      cfi: location?.start.cfi,
      percentage: book.percentage,
    })
  }, [sync, book.percentage, location?.start.cfi])

  useEffect(() => {
    sync({
      definitions: book.definitions as string[],
    })
  }, [book.definitions, sync])

  useEffect(() => {
    sync({
      annotations: book.annotations as Annotation[],
    })
  }, [book.annotations, sync])

  useEffect(() => {
    const localBook = {
      id,
      name: book.name,
      bookmarks: book.bookmarks as Bookmark[],
    }

    mutateRemoteBookmarks(
      (remoteBookmarkFiles) => {
        if (!remoteBookmarkFiles) return

        uploadBookmarks(localBook)
        const bookmarkFile = toDropboxBookmarkFile(localBook)
        const i = remoteBookmarkFiles.findIndex((file) => file.bookId === id)

        if (i < 0) return [...remoteBookmarkFiles, bookmarkFile]
        return remoteBookmarkFiles.map((file, index) =>
          index === i ? bookmarkFile : file,
        )
      },
      { revalidate: false },
    )
  }, [book.bookmarks, book.name, id, mutateRemoteBookmarks])

  useEffect(() => {
    sync({
      configuration: book.configuration,
    })
  }, [book.configuration, sync])
}
