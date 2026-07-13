import useSWR from 'swr/immutable'

import {
  BOOKMARKS_PATH,
  DATA_FILENAME,
  dropboxBookmarksFetcher,
  dropboxBooksFetcher,
  dropboxFilesFetcher,
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
