import { Dropbox } from 'dropbox'
import { saveAs } from 'file-saver'
import JSZip from 'jszip'
import { parseCookies } from 'nookies'

import { Annotation } from './annotation'
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

interface SerializedBookRecord
  extends Omit<
    BookRecord,
    'annotations' | 'annotationTombstones' | 'bookmarks'
  > {
  annotations?: Annotation[]
  annotationTombstones?: Record<string, number>
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

export interface DropboxNoteFile {
  version: number
  bookId: string
  bookName?: string
  annotations: Annotation[]
  annotationTombstones?: Record<string, number>
}

const VERSION = 1
export const DATA_FILENAME = 'data.json'
export const BOOKMARKS_PATH = '/bookmarks'
export const NOTES_PATH = '/notes'

function normalizeBookRecord(book: SerializedBookRecord): BookRecord {
  return {
    ...book,
    definitions: book.definitions ?? [],
    annotations: book.annotations ?? [],
    annotationTombstones: book.annotationTombstones ?? {},
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

interface AnnotationState {
  annotations?: readonly Annotation[]
  annotationTombstones?: Readonly<Record<string, number>>
}

function mergeAnnotationState(...sources: AnnotationState[]) {
  const merged = new Map<string, Annotation>()
  const annotationTombstones: Record<string, number> = {}

  sources.forEach(({ annotations, annotationTombstones: tombstones }) => {
    annotations?.forEach((annotation) => {
      const existing = merged.get(annotation.id)
      const updatedAt = annotation.updatedAt ?? annotation.createAt
      const existingUpdatedAt = existing?.updatedAt ?? existing?.createAt ?? 0
      if (!existing || updatedAt >= existingUpdatedAt) {
        merged.set(annotation.id, annotation)
      }
    })

    Object.entries(tombstones ?? {}).forEach(([id, deletedAt]) => {
      annotationTombstones[id] = Math.max(
        annotationTombstones[id] ?? 0,
        deletedAt,
      )
    })
  })

  Object.entries(annotationTombstones).forEach(([id, deletedAt]) => {
    const annotation = merged.get(id)
    const updatedAt = annotation?.updatedAt ?? annotation?.createAt ?? 0
    if (annotation && deletedAt >= updatedAt) merged.delete(id)
  })

  return {
    annotations: [...merged.values()].sort((a, b) => a.createAt - b.createAt),
    annotationTombstones,
  }
}

export function mergeAnnotations(
  ...sources: Array<readonly Annotation[] | undefined>
) {
  return mergeAnnotationState(
    ...sources.map((annotations) => ({ annotations })),
  ).annotations
}

function haveAnnotationsChanged(
  a: readonly Annotation[] = [],
  b: readonly Annotation[] = [],
) {
  return JSON.stringify(a) !== JSON.stringify(b)
}

export function mergeBooksWithDropboxData(
  localBooks: BookRecord[],
  remoteBooks: BookRecord[],
  remoteBookmarkFiles: DropboxBookmarkFile[] = [],
  remoteNoteFiles: DropboxNoteFile[] = [],
) {
  const bookmarkChanges: BookRecord[] = []
  const annotationChanges: BookRecord[] = []
  const localById = new Map(localBooks.map((book) => [book.id, book]))
  const remoteBookmarksByBookId = new Map(
    remoteBookmarkFiles.map((file) => [file.bookId, file.bookmarks]),
  )
  const remoteNotesByBookId = new Map(
    remoteNoteFiles.map((file) => [file.bookId, file]),
  )

  const books = remoteBooks.map((remoteBook) => {
    const remote = normalizeBookRecord(remoteBook)
    const local = localById.get(remote.id)
    const hasBookmarkFile = remoteBookmarksByBookId.has(remote.id)
    const syncedBookmarks = hasBookmarkFile
      ? remoteBookmarksByBookId.get(remote.id)!
      : remote.bookmarks
    const bookmarks = mergeBookmarks(local?.bookmarks, syncedBookmarks)
    const hasNoteFile = remoteNotesByBookId.has(remote.id)
    const remoteNoteFile = remoteNotesByBookId.get(remote.id)
    const syncedAnnotations = remoteNoteFile?.annotations ?? remote.annotations
    const syncedAnnotationTombstones =
      remoteNoteFile?.annotationTombstones ?? {}
    const baseAnnotationState = remoteNoteFile
      ? {
          annotations: remoteNoteFile.annotations,
          annotationTombstones: remoteNoteFile.annotationTombstones,
        }
      : {
          annotations: remote.annotations,
          annotationTombstones: remote.annotationTombstones,
        }
    const { annotations, annotationTombstones } = mergeAnnotationState(
      baseAnnotationState,
      {
        annotations: local?.annotations,
        annotationTombstones: local?.annotationTombstones,
      },
    )

    const book = {
      ...remote,
      annotations,
      annotationTombstones,
      bookmarks,
    }
    if (
      haveBookmarksChanged(bookmarks, syncedBookmarks) ||
      (!hasBookmarkFile && bookmarks.length > 0)
    ) {
      bookmarkChanges.push(book)
    }
    if (
      haveAnnotationsChanged(annotations, syncedAnnotations) ||
      JSON.stringify(annotationTombstones) !==
        JSON.stringify(syncedAnnotationTombstones) ||
      (!hasNoteFile && annotations.length > 0)
    ) {
      annotationChanges.push(book)
    }
    return book
  })

  return { books, bookmarkChanges, annotationChanges }
}

function serializeData(books?: BookRecord[], includeBookData = true) {
  return JSON.stringify({
    version: VERSION,
    dbVersion: db?.verno,
    books: books?.map((book) => {
      const serialized: Partial<BookRecord> = normalizeBookRecord(book)
      if (!includeBookData) {
        delete serialized.annotations
        delete serialized.annotationTombstones
        delete serialized.bookmarks
      }
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

export function toDropboxNoteFile(
  book: Pick<
    BookRecord,
    'id' | 'name' | 'annotations' | 'annotationTombstones'
  >,
): DropboxNoteFile {
  return {
    version: VERSION,
    bookId: book.id,
    bookName: book.name,
    annotations: book.annotations as Annotation[],
    annotationTombstones: book.annotationTombstones,
  }
}

export function getDropboxNotePath(bookId: string) {
  return `${NOTES_PATH}/${bookId}.json`
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

let notesFolderReady = false
let notesFolderRequest: Promise<void> | undefined

async function ensureNotesFolder() {
  if (notesFolderReady) return
  if (notesFolderRequest) return notesFolderRequest

  notesFolderRequest = dbx
    .filesCreateFolderV2({ path: NOTES_PATH })
    .then(() => undefined)
    .catch((error) => {
      if (!hasDropboxError(error, 'conflict')) throw error
    })
    .then(() => {
      notesFolderReady = true
    })
    .finally(() => {
      notesFolderRequest = undefined
    })

  return notesFolderRequest
}

export async function uploadNotes(
  book: Pick<
    BookRecord,
    'id' | 'name' | 'annotations' | 'annotationTombstones'
  >,
) {
  return enqueueDropboxWrite(async () => {
    await ensureNotesFolder()

    const localNoteFile = toDropboxNoteFile(book)

    for (let attempt = 0; attempt < 3; attempt++) {
      let remoteNoteFile: DropboxNoteFile | undefined
      let remoteRevision: string | undefined
      try {
        const response = await dbx.filesDownload({
          path: getDropboxNotePath(book.id),
        })
        const result = response.result as any
        const blob: Blob = result.fileBlob
        const text = await readBlob((reader) => reader.readAsText(blob))
        remoteNoteFile = JSON.parse(text) as DropboxNoteFile
        remoteRevision = result.rev
      } catch (error) {
        if (!hasDropboxError(error, 'not_found')) throw error
      }

      const { annotations, annotationTombstones } = mergeAnnotationState(
        remoteNoteFile ?? {},
        localNoteFile,
      )
      const noteFile = {
        ...localNoteFile,
        annotations,
        annotationTombstones,
      }

      try {
        await dbx.filesUpload({
          path: getDropboxNotePath(book.id),
          mode: remoteRevision
            ? { '.tag': 'update', update: remoteRevision }
            : { '.tag': 'add' },
          autorename: false,
          strict_conflict: true,
          contents: JSON.stringify(noteFile),
        })
        return noteFile
      } catch (error) {
        if (attempt === 2 || !hasDropboxError(error, 'conflict')) throw error
      }
    }
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

export const dropboxNotesFetcher = async () => {
  let entries
  try {
    entries = (await dbx.filesListFolder({ path: NOTES_PATH })).result.entries
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
          .then((text) => JSON.parse(text) as DropboxNoteFile),
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
