import { useBoolean } from '@literal-ui/hooks'
import dayjs from 'dayjs'
import { useEffect, useMemo } from 'react'

import { Bookmark } from '@flow/reader/bookmark'
import { useTranslation } from '@flow/reader/hooks'
import {
  BookTab,
  compareHref,
  INavItem,
  ISection,
  reader,
  useReaderSnapshot,
} from '@flow/reader/models'

import { Row } from '../Row'
import { PaneViewProps, PaneView, Pane } from '../base'

interface BookmarkTreeNode {
  id: string
  label: string
  children: BookmarkTreeNode[]
  bookmarks: Bookmark[]
  bookmarkIds: string[]
}

interface BookmarkPathSegment {
  id: string
  label: string
}

export const BookmarkView: React.FC<PaneViewProps> = (props) => {
  const { focusedBookTab } = useReaderSnapshot()
  const tab = reader.focusedBookTab
  const t = useTranslation('bookmark')
  const bookmarkSnapshot = focusedBookTab?.book.bookmarks
  const bookmarks = useMemo(
    () => (bookmarkSnapshot as Bookmark[] | undefined) ?? [],
    [bookmarkSnapshot],
  )
  const toc = focusedBookTab?.nav?.toc as unknown as INavItem[] | undefined
  const sections = focusedBookTab?.sections as unknown as ISection[] | undefined
  const bookTitle =
    focusedBookTab?.book.metadata.title.trim() ||
    focusedBookTab?.book.name ||
    ''
  const bookmarkTree = buildBookmarkTree(
    tab,
    bookmarks,
    bookTitle,
    toc,
    sections,
  )

  useEffect(() => {
    void tab?.populateMissingBookmarkPercentages()
  }, [bookmarks, focusedBookTab?.epub, tab])

  return (
    <PaneView {...props}>
      <Pane headline={t('bookmarks')}>
        {bookmarkTree.map((node) => (
          <BookmarkTreeBranch key={node.id} depth={1} node={node} />
        ))}
      </Pane>
    </PaneView>
  )
}

interface BookmarkTreeBranchProps {
  depth: number
  node: BookmarkTreeNode
}
const BookmarkTreeBranch: React.FC<BookmarkTreeBranchProps> = ({
  depth,
  node,
}) => {
  const [expanded, toggle] = useBoolean(true)

  return (
    <div>
      <Row
        depth={depth}
        badge
        expanded={expanded}
        toggle={toggle}
        subitems={node.bookmarkIds}
      >
        {node.label}
      </Row>

      {expanded && (
        <div>
          {node.children.map((child) => (
            <BookmarkTreeBranch key={child.id} depth={depth + 1} node={child} />
          ))}
          {node.bookmarks.map((bookmark) => (
            <BookmarkRow
              key={bookmark.id}
              bookmark={bookmark}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface BookmarkRowProps {
  bookmark: Bookmark
  depth: number
}
const BookmarkRow: React.FC<BookmarkRowProps> = ({ bookmark, depth }) => (
  <Row
    depth={depth}
    deletePosition="start"
    info={dayjs(bookmark.updatedAt).format('YYYY-MM-DD HH:mm')}
    onClick={() => {
      reader.focusedBookTab?.displayBookmark(bookmark.cfi)
    }}
    onDelete={() => {
      reader.focusedBookTab?.removeBookmark(bookmark.id)
    }}
  >
    {bookmark.percentage !== undefined
      ? `${(bookmark.percentage * 100).toFixed()}%`
      : '…'}
  </Row>
)

function buildBookmarkTree(
  tab: BookTab | undefined,
  bookmarks: Bookmark[],
  bookTitle: string,
  toc: INavItem[] | undefined,
  sections: ISection[] | undefined,
) {
  const roots: BookmarkTreeNode[] = []
  const sortedBookmarks = [...bookmarks].sort(compareBookmarks)

  sortedBookmarks.forEach((bookmark) => {
    const chapterTitle = getChapterTitle(tab, sections, bookmark)
    const navPath = findBestNavPath(toc, sections, bookmark, chapterTitle)
    const path: BookmarkPathSegment[] = []

    addPathSegment(path, {
      id: `book:${bookmark.bookId}`,
      label: bookTitle || bookmark.bookId,
    })
    navPath.forEach((item) =>
      addPathSegment(path, {
        id: `nav:${item.id}`,
        label: item.label.trim(),
      }),
    )
    addPathSegment(path, {
      id: `chapter:${bookmark.spine.index}`,
      label: chapterTitle,
    })

    let nodes = roots
    let leaf: BookmarkTreeNode | undefined
    path.forEach((segment) => {
      leaf = nodes.find((node) => node.id === segment.id)
      if (!leaf) {
        leaf = {
          ...segment,
          children: [],
          bookmarks: [],
          bookmarkIds: [],
        }
        nodes.push(leaf)
      }
      nodes = leaf.children
    })
    leaf?.bookmarks.push(bookmark)
  })

  roots.forEach(populateBookmarkIds)
  return roots
}

function compareBookmarks(a: Bookmark, b: Bookmark) {
  if (a.percentage !== undefined && b.percentage !== undefined) {
    return a.percentage - b.percentage
  }
  return (
    a.spine.index - b.spine.index ||
    (a.displayed?.page ?? Number.MAX_SAFE_INTEGER) -
      (b.displayed?.page ?? Number.MAX_SAFE_INTEGER)
  )
}

function getChapterTitle(
  tab: BookTab | undefined,
  sections: ISection[] | undefined,
  bookmark: Bookmark,
) {
  const section = sections?.find(
    (section) => section.index === bookmark.spine.index,
  )
  const title = tab?.getSectionTitle(section, bookmark.href)

  return title || bookmark.spine.title
}

function findBestNavPath(
  toc: INavItem[] | undefined,
  sections: ISection[] | undefined,
  bookmark: Bookmark,
  chapterTitle: string,
) {
  let bestExactPath: INavItem[] = []
  let bestExactScore = -1
  let bestPreviousPath: INavItem[] = []
  let bestPreviousSectionIndex = -1
  let bestPreviousScore = -1
  const normalizedChapterTitle = normalizeLabel(chapterTitle)

  const visit = (items: INavItem[] = [], parents: INavItem[] = []) => {
    items.forEach((item) => {
      const path = [...parents, item]
      const labelMatches = normalizeLabel(item.label) === normalizedChapterTitle
      if (compareHref(bookmark.href, item.href)) {
        const score = (labelMatches ? 1000 : 0) + path.length
        if (score > bestExactScore) {
          bestExactPath = path
          bestExactScore = score
        }
      }

      const navSectionIndex = sections?.findIndex((section) =>
        compareHref(section.href, item.href),
      )
      if (
        navSectionIndex !== undefined &&
        navSectionIndex >= 0 &&
        navSectionIndex <= bookmark.spine.index
      ) {
        const score = (labelMatches ? 1000 : 0) + path.length
        if (
          navSectionIndex > bestPreviousSectionIndex ||
          (navSectionIndex === bestPreviousSectionIndex &&
            score > bestPreviousScore)
        ) {
          bestPreviousPath = path
          bestPreviousSectionIndex = navSectionIndex
          bestPreviousScore = score
        }
      }
      visit(item.subitems, path)
    })
  }

  visit(toc)
  return bestExactPath.length ? bestExactPath : bestPreviousPath
}

function addPathSegment(
  path: BookmarkPathSegment[],
  segment: BookmarkPathSegment,
) {
  if (!segment.label) return
  const previous = path[path.length - 1]
  if (
    previous &&
    normalizeLabel(previous.label) === normalizeLabel(segment.label)
  ) {
    return
  }
  path.push(segment)
}

function populateBookmarkIds(node: BookmarkTreeNode): string[] {
  node.bookmarkIds = [
    ...node.bookmarks.map((bookmark) => bookmark.id),
    ...node.children.flatMap(populateBookmarkIds),
  ]
  return node.bookmarkIds
}

function normalizeLabel(label: string) {
  return label
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '')
}
