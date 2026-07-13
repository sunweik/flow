export interface Bookmark {
  id: string
  bookId: string
  cfi: string
  href: string
  spine: {
    index: number
    title: string
  }
  displayed?: {
    page: number
    total: number
  }
  percentage?: number
  createdAt: number
  updatedAt: number
}
