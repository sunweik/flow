import useSWR from 'swr/immutable'

import {
  BOOKMARKS_PATH,
  DATA_FILENAME,
  NOTES_PATH,
  dropboxBookmarksFetcher,
  dropboxBooksFetcher,
  dropboxFilesFetcher,
  dropboxNotesFetcher,
} from '@flow/reader/sync'

export function useRemoteFiles() {
  return useSWR('/files', dropboxFilesFetcher, { shouldRetryOnError: false })
}

export function useRemoteBooks() {
  return useSWR(`/${DATA_FILENAME}`, dropboxBooksFetcher, {
    shouldRetryOnError: false,
  })
}

export function useRemoteBookmarks() {
  return useSWR(BOOKMARKS_PATH, dropboxBookmarksFetcher, {
    shouldRetryOnError: false,
  })
}

export function useRemoteNotes() {
  return useSWR(NOTES_PATH, dropboxNotesFetcher, {
    shouldRetryOnError: false,
  })
}
