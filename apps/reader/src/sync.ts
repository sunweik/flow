import { Dropbox } from 'dropbox'
import { saveAs } from 'file-saver'
import JSZip from 'jszip'
import { parseCookies } from 'nookies'

import { Bookmark } from './bookmark'
import { BookRecord, db } from './db'
import { readBlob } from './file'

export const mapToToken = {
  dropbox: 'dropbox-refresh-token',
}

export const OAUTH_SUCCESS_MESSAGE = 'oauth_success'

export const DROPBOX_SCOPES = [
  'files.metadata.read',
  'files.content.read',
  'files.content.write',
]

export const dbx = new Dropbox({
  clientId: process.env.NEXT_PUBLIC_DROPBOX_CLIENT_ID,
  refreshToken: '__fake_token__',
})

let dropboxWriteQueue = Promise.resolve()

export function enqueueDropboxWrite<T>(operation: () => Promise<T>) {
  const result = dropboxWriteQueue.then(async () => {
    try {
      return await operation()
    } catch (error) {
      console.warn('Dropbox write failed', error)
      return undefined
    }
  })

  dropboxWriteQueue = result.then(() => undefined)
  return result
}

let _req: Promise<void> | undefined
dbx.auth.refreshAccessToken = () => {
  const cookies = parseCookies()
  const refreshToken = cookies[mapToToken['dropbox']]
  if (!refreshToken) {
    // `reject` to skip subsequent api requests
    return Promise.reject()
  }
  _req ??= fetch(`/api/refresh`)
    .then((res) => res.json())
    .then((data) => {
      dbx.auth.setAccessToken(data.accessToken)
      dbx.auth.setAccessTokenExpiresAt(data.accessTokenExpiresAt)
    })
    .finally(() => {
      // will fail if no refresh token
      _req = undefined
    })
  return _req
}

interface SerializedBookRecord extends Omit<BookRecord, 'bookmarks'> {
  bookmarks?: Bookmark[]
}

interface SerializedBooks {
  version: number
  dbVersion: number
  books: SerializedBookRecord[]
}

export interface DropboxBookmarkFile {
  version: number
  bookId: string
  bookName?: string
  bookmarks: Bookmark[]
}

const VERSION = 1
export const DATA_FILENAME = 'data.json'
export const BOOKMARKS_PATH = '/bookmarks'

function normalizeBookRecord(book: SerializedBookRecord): BookRecord {
  return {
    ...book,
    definitions: book.definitions ?? [],
    annotations: book.annotations ?? [],
    bookmarks: book.bookmarks ?? [],
  }
}

function mergeBookmarks(local: Bookmark[] = [], remote: Bookmark[] = []) {
  const merged = new Map<string, Bookmark>()

  remote.forEach((bookmark) => {
    merged.set(bookmark.id, bookmark)
  })

  local.forEach((bookmark) => {
    const existing = merged.get(bookmark.id)
    if (!existing || bookmark.updatedAt > existing.updatedAt) {
      merged.set(bookmark.id, bookmark)
    }
  })

  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
}

function haveBookmarksChanged(a: Bookmark[] = [], b: Bookmark[] = []) {
  return JSON.stringify(a) !== JSON.stringify(b)
}

export function mergeBooksWithBookmarks(
  localBooks: BookRecord[],
  remoteBooks: BookRecord[],
  remoteBookmarkFiles: DropboxBookmarkFile[] = [],
) {
  const bookmarkChanges: BookRecord[] = []
  const localById = new Map(localBooks.map((book) => [book.id, book]))
  const remoteBookmarksByBookId = new Map(
    remoteBookmarkFiles.map((file) => [file.bookId, file.bookmarks]),
  )

  const books = remoteBooks.map((remoteBook) => {
    const remote = normalizeBookRecord(remoteBook)
    const local = localById.get(remote.id)
    const hasBookmarkFile = remoteBookmarksByBookId.has(remote.id)
    const syncedBookmarks = hasBookmarkFile
      ? remoteBookmarksByBookId.get(remote.id)!
      : remote.bookmarks
    const bookmarks = mergeBookmarks(local?.bookmarks, syncedBookmarks)

    const book = {
      ...remote,
      bookmarks,
    }
    if (
      haveBookmarksChanged(bookmarks, syncedBookmarks) ||
      (!hasBookmarkFile && bookmarks.length > 0)
    ) {
      bookmarkChanges.push(book)
    }

    return book
  })

  return { books, changed: bookmarkChanges.length > 0, bookmarkChanges }
}

function serializeData(books?: BookRecord[], includeBookmarks = true) {
  return JSON.stringify({
    version: VERSION,
    dbVersion: db?.verno,
    books: books?.map((book) => {
      const serialized: Partial<BookRecord> = normalizeBookRecord(book)
      if (!includeBookmarks) delete serialized.bookmarks
      return serialized
    }),
  })
}

function deserializeData(text: string) {
  const { version, dbVersion, books } = JSON.parse(text) as SerializedBooks

  if (version < VERSION) {
    // migrate `data.json`
  }
  if (db && dbVersion < db.verno) {
    // migrate `BookRecord`
  }

  return books.map(normalizeBookRecord)
}

export async function uploadData(books: BookRecord[]) {
  return enqueueDropboxWrite(() =>
    dbx.filesUpload({
      path: `/${DATA_FILENAME}`,
      mode: { '.tag': 'overwrite' },
      contents: serializeData(books, false),
    }),
  )
}

export function toDropboxBookmarkFile(
  book: Pick<BookRecord, 'id' | 'name' | 'bookmarks'>,
): DropboxBookmarkFile {
  return {
    version: VERSION,
    bookId: book.id,
    bookName: book.name,
    bookmarks: book.bookmarks as Bookmark[],
  }
}

export function getDropboxBookmarkPath(bookId: string) {
  return `${BOOKMARKS_PATH}/${bookId}.json`
}

let bookmarksFolderReady = false
let bookmarksFolderRequest: Promise<void> | undefined

function hasDropboxError(error: unknown, value: string) {
  try {
    return JSON.stringify((error as any)?.error ?? error).includes(value)
  } catch {
    return false
  }
}

async function ensureBookmarksFolder() {
  if (bookmarksFolderReady) return
  if (bookmarksFolderRequest) return bookmarksFolderRequest

  bookmarksFolderRequest = dbx
    .filesCreateFolderV2({ path: BOOKMARKS_PATH })
    .then(() => undefined)
    .catch((error) => {
      if (!hasDropboxError(error, 'conflict')) throw error
    })
    .then(() => {
      bookmarksFolderReady = true
    })
    .finally(() => {
      bookmarksFolderRequest = undefined
    })

  return bookmarksFolderRequest
}

export async function uploadBookmarks(
  book: Pick<BookRecord, 'id' | 'name' | 'bookmarks'>,
) {
  return enqueueDropboxWrite(async () => {
    await ensureBookmarksFolder()
    return dbx.filesUpload({
      path: getDropboxBookmarkPath(book.id),
      mode: { '.tag': 'overwrite' },
      contents: JSON.stringify(toDropboxBookmarkFile(book)),
    })
  })
}

export const dropboxFilesFetcher = (path: string) => {
  return dbx.filesListFolder({ path }).then((d) => d.result.entries)
}

export const dropboxBooksFetcher = (path: string) => {
  return dbx
    .filesDownload({ path })
    .then((d) => {
      const blob: Blob = (d.result as any).fileBlob
      return readBlob((r) => r.readAsText(blob))
    })
    .then((d) => deserializeData(d))
}

export const dropboxBookmarksFetcher = async () => {
  let entries
  try {
    entries = (await dbx.filesListFolder({ path: BOOKMARKS_PATH })).result
      .entries
  } catch (error) {
    if (hasDropboxError(error, 'not_found')) return []
    throw error
  }

  return Promise.all(
    entries
      .filter(
        (entry) => entry['.tag'] === 'file' && entry.name.endsWith('.json'),
      )
      .map((entry) =>
        dbx
          .filesDownload({ path: entry.path_lower! })
          .then((d) => {
            const blob: Blob = (d.result as any).fileBlob
            return readBlob((r) => r.readAsText(blob))
          })
          .then((text) => JSON.parse(text) as DropboxBookmarkFile),
      ),
  )
}

export async function pack() {
  const books = await db?.books.toArray()
  const covers = await db?.covers.toArray()
  const files = await db?.files.toArray()

  const zip = new JSZip()
  zip.file(DATA_FILENAME, serializeData(books))
  zip.file('covers.json', JSON.stringify(covers))

  const folder = zip.folder('files')
  files?.forEach((f) => folder?.file(f.file.name, f.file))

  const date = new Intl.DateTimeFormat('fr-CA').format().replaceAll('-', '')

  return zip.generateAsync({ type: 'blob' }).then((content) => {
    saveAs(content, `flow_backup_${date}.zip`)
  })
}

export async function unpack(file: File) {
  const zip = new JSZip()
  await zip.loadAsync(file)

  const booksJSON = zip.file(DATA_FILENAME)
  const coversJSON = zip.file('covers.json')
  if (!booksJSON || !coversJSON) return

  const books = deserializeData(await booksJSON.async('text'))

  db?.books.bulkPut(books)

  const coversText = await coversJSON.async('text')
  db?.covers.bulkPut(JSON.parse(coversText))

  const folder = zip.folder('files')
  folder?.forEach(async (_, f) => {
    const book = books.find((b) => `files/${b.name}` === f.name)
    if (!book) return

    const data = await f.async('blob')
    const file = new File([data], book.name)
    db?.files.put({ file, id: book.id })
  })
}
