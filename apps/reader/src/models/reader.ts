import { debounce } from '@github/mini-throttle/decorators'
import { IS_SERVER } from '@literal-ui/hooks'
import React from 'react'
import { v4 as uuidv4 } from 'uuid'
import { proxy, ref, snapshot, subscribe, useSnapshot } from 'valtio'

import type { Rendition, Location, Book } from '@flow/epubjs'
import Navigation, { NavItem } from '@flow/epubjs/types/navigation'
import Section from '@flow/epubjs/types/section'

import { AnnotationColor, AnnotationType } from '../annotation'
import { Bookmark } from '../bookmark'
import { BookRecord, db } from '../db'
import { fileToEpub } from '../file'
import { defaultStyle } from '../styles'

import { dfs, find, INode } from './tree'

function updateIndex(array: any[], deletedItemIndex: number) {
  const last = array.length - 1
  return deletedItemIndex > last ? last : deletedItemIndex
}

export function compareHref(
  sectionHref: string | undefined,
  navitemHref: string | undefined,
) {
  if (sectionHref && navitemHref) {
    const [target] = navitemHref.split('#')

    return (
      sectionHref.endsWith(target!) ||
      // fix for relative nav path `../Text/example.html`
      target?.endsWith(sectionHref)
    )
  }
}

function compareDefinition(d1: string, d2: string) {
  return d1.toLowerCase() === d2.toLowerCase()
}

export interface INavItem extends NavItem, INode {
  subitems?: INavItem[]
}

export interface IMatch extends INode {
  excerpt: string
  description?: string
  cfi?: string
  subitems?: IMatch[]
}

export interface ISection extends Section {
  length: number
  images: string[]
  navitem?: INavItem
}

interface TimelineItem {
  location: Location
  timestamp: number
}

interface LocationHistoryItem {
  location: Location
  percentage?: number
}

class BaseTab {
  constructor(public readonly id: string, public readonly title = id) {}

  get isBook(): boolean {
    return this instanceof BookTab
  }

  get isPage(): boolean {
    return this instanceof PageTab
  }
}

// https://github.com/pmndrs/valtio/blob/92f3311f7f1a9fe2a22096cd30f9174b860488ed/src/vanilla.ts#L6
type AsRef = { $$valtioRef: true }

export class BookTab extends BaseTab {
  epub?: Book
  iframe?: Window & AsRef
  rendition?: Rendition & { manager?: any }
  nav?: Navigation
  locationHistory: LocationHistoryItem[] = []
  section?: ISection
  sections?: ISection[]
  results?: IMatch[]
  activeResultID?: string
  rendered = false
  private bookmarkLocationsRequest?: Promise<void>

  get container() {
    return this?.rendition?.manager?.container as HTMLDivElement | undefined
  }

  timeline: TimelineItem[] = []
  get location() {
    return this.timeline[0]?.location
  }

  get locationToReturn() {
    return this.locationHistory[this.locationHistory.length - 1]?.location
  }

  get locationToReturnPercentage() {
    return this.locationHistory[this.locationHistory.length - 1]?.percentage
  }

  display(target?: string, returnable = true) {
    this.rendition?.display(target)
    if (returnable) this.showPrevLocation()
  }

  private bookmarkDisplayRequest = 0

  private waitForRelocated(rendition: Rendition) {
    return new Promise<Location | undefined>((resolve) => {
      const onRelocated = (location: Location) => {
        clearTimeout(timeout)
        rendition.off('relocated', onRelocated)
        resolve(location)
      }
      const timeout = setTimeout(() => {
        rendition.off('relocated', onRelocated)
        resolve(undefined)
      }, 2000)

      rendition.on('relocated', onRelocated)
    })
  }

  private async displayAndWaitForRelocation(
    rendition: Rendition,
    target: string,
  ) {
    const relocated = this.waitForRelocated(rendition)
    try {
      await rendition.display(target)
      return await relocated
    } catch (error) {
      console.warn('Could not display bookmark', error)
    }
  }

  async displayBookmark(target: string) {
    const rendition = this.rendition
    if (!rendition) return

    const request = ++this.bookmarkDisplayRequest
    this.showPrevLocation()
    await this.displayAndWaitForRelocation(rendition, target)

    // Opening a sidebar can trigger another pagination immediately after the
    // first relocation. Wait for that layout pass before verifying the CFI.
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    if (
      request !== this.bookmarkDisplayRequest ||
      this.isCfiInCurrentLocation(target)
    ) {
      return
    }

    await this.displayAndWaitForRelocation(rendition, target)
  }

  displayFromSelector(selector: string, section: ISection, returnable = true) {
    try {
      const el = section.document.querySelector(selector)
      if (el) this.display(section.cfiFromElement(el), returnable)
    } catch (err) {
      this.display(section.href, returnable)
    }
  }
  prev() {
    this.rendition?.prev()
    // avoid content flash
    if (this.container?.scrollLeft === 0 && !this.location?.atStart) {
      this.rendered = false
    }
  }
  next() {
    this.rendition?.next()
  }

  updateBook(changes: Partial<BookRecord>) {
    changes = {
      ...changes,
      updatedAt: Date.now(),
    }
    // don't wait promise resolve to make valtio batch updates
    this.book = { ...this.book, ...changes }
    db?.books.update(this.book.id, changes)
  }

  annotationRange?: Range
  setAnnotationRange(cfi: string) {
    const range = this.view?.contents.range(cfi)
    if (range) this.annotationRange = ref(range)
  }

  define(def: string[]) {
    this.updateBook({ definitions: [...this.book.definitions, ...def] })
  }
  undefine(def: string) {
    this.updateBook({
      definitions: this.book.definitions.filter(
        (d) => !compareDefinition(d, def),
      ),
    })
  }
  isDefined(def: string) {
    return this.book.definitions.some((d) => compareDefinition(d, def))
  }

  rangeToCfi(range: Range) {
    return this.view.contents.cfiFromRange(range)
  }
  putAnnotation(
    type: AnnotationType,
    cfi: string,
    color: AnnotationColor,
    text: string,
    notes?: string,
  ) {
    const spine = this.section
    if (!spine?.navitem) return

    const i = this.book.annotations.findIndex((a) => a.cfi === cfi)
    let annotation = this.book.annotations[i]

    const now = Date.now()
    if (!annotation) {
      annotation = {
        id: uuidv4(),
        bookId: this.book.id,
        cfi,
        spine: {
          index: spine.index,
          title: spine.navitem.label,
        },
        createAt: now,
        updatedAt: now,
        type,
        color,
        notes,
        text,
      }

      this.updateBook({
        // DataCloneError: Failed to execute 'put' on 'IDBObjectStore': #<Object> could not be cloned.
        annotations: [...snapshot(this.book.annotations), annotation],
      })
    } else {
      annotation = {
        ...this.book.annotations[i]!,
        type,
        updatedAt: now,
        color,
        notes,
        text,
      }
      this.book.annotations.splice(i, 1, annotation)
      this.updateBook({
        annotations: [...snapshot(this.book.annotations)],
      })
    }
  }
  removeAnnotation(cfi: string) {
    return this.updateBook({
      annotations: snapshot(this.book.annotations).filter((a) => a.cfi !== cfi),
    })
  }

  getCurrentBookmark() {
    return this.book.bookmarks.find((bookmark) =>
      this.isCfiInCurrentLocation(bookmark.cfi),
    )
  }

  isCfiInCurrentLocation(cfi: string) {
    const location = this.location
    if (!location) return false
    if (cfi === location.start.cfi) return true

    const epubcfi = this.rendition?.epubcfi
    if (!epubcfi) return false

    try {
      return (
        epubcfi.compare(location.start.cfi, cfi) <= 0 &&
        epubcfi.compare(cfi, location.end.cfi) <= 0
      )
    } catch {
      return false
    }
  }

  putBookmark() {
    const location = this.location
    const spine = this.section
    if (!location || !spine) return

    const existing = this.getCurrentBookmark()
    const now = Date.now()
    const bookmark: Bookmark = {
      id: existing?.id ?? uuidv4(),
      bookId: this.book.id,
      cfi: location.start.cfi,
      href: location.start.href,
      spine: {
        index: spine.index,
        title:
          this.getSectionTitle(spine, location.start.href) ??
          location.start.href,
      },
      displayed: {
        page: location.start.displayed.page,
        total: location.start.displayed.total,
      },
      percentage:
        this.book.percentage ??
        this.getGeneratedBookmarkPercentage(location.start.cfi),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    const bookmarks = [...snapshot(this.book.bookmarks)]
    const i = bookmarks.findIndex((b) => b.id === bookmark.id)
    if (i < 0) {
      bookmarks.push(bookmark)
    } else {
      bookmarks.splice(i, 1, bookmark)
    }

    this.updateBook({ bookmarks })
  }

  removeBookmark(id: string) {
    return this.updateBook({
      bookmarks: snapshot(this.book.bookmarks).filter((b) => b.id !== id),
    })
  }

  private getGeneratedBookmarkPercentage(cfi: string) {
    try {
      const percentage = this.epub?.locations.percentageFromCfi(cfi)
      return typeof percentage === 'number' && Number.isFinite(percentage)
        ? Math.min(1, Math.max(0, percentage))
        : undefined
    } catch {
      return undefined
    }
  }

  async populateMissingBookmarkPercentages() {
    const epub = this.epub
    if (
      !epub ||
      !this.book.bookmarks.some((bookmark) => bookmark.percentage === undefined)
    ) {
      return
    }

    try {
      if (!epub.locations.length()) {
        this.bookmarkLocationsRequest ??= ref(
          epub.locations.generate(1024).then(() => undefined),
        )
        await this.bookmarkLocationsRequest
      }

      let changed = false
      const bookmarks = snapshot(this.book.bookmarks).map((bookmark) => {
        if (bookmark.percentage !== undefined) return bookmark

        const percentage = this.getGeneratedBookmarkPercentage(bookmark.cfi)
        if (percentage === undefined) return bookmark

        changed = true
        return { ...bookmark, percentage }
      })

      if (changed) this.updateBook({ bookmarks })
    } catch (error) {
      console.warn('Could not calculate bookmark percentages', error)
    }
  }

  keyword = ''
  setKeyword(keyword: string) {
    if (this.keyword === keyword) return
    this.keyword = keyword
    this.onKeywordChange()
  }

  // only use throttle/debounce for side effects
  @debounce(1000)
  async onKeywordChange() {
    this.results = await this.search()
  }

  get totalLength() {
    return this.sections?.reduce((acc, s) => acc + s.length, 0) ?? 0
  }

  toggle(id: string) {
    const item = find(this.nav?.toc, id) as INavItem
    if (item) item.expanded = !item.expanded
  }

  toggleResult(id: string) {
    const item = find(this.results, id)
    if (item) item.expanded = !item.expanded
  }

  showPrevLocation() {
    const location = this.location
    if (!location) return

    const previous = this.locationHistory[this.locationHistory.length - 1]
    if (previous?.location.start.cfi === location.start.cfi) return

    this.locationHistory.push({
      location,
      percentage: this.book.percentage,
    })
    if (this.locationHistory.length > 100) this.locationHistory.shift()
  }

  hidePrevLocation() {
    this.locationHistory.splice(0)
  }

  returnToPreviousLocation() {
    const previous = this.locationHistory.pop()
    if (!previous) return

    this.display(previous.location.end.cfi, false)
  }

  getLocationTitle(location = this.locationToReturn) {
    const href = location?.start.href
    if (!href) return

    const section = this.sections?.find((section) =>
      compareHref(section.href, href),
    )
    const title = this.getSectionTitle(section, href)

    return title === href ? undefined : title
  }

  mapSectionToNavItem(sectionHref: string) {
    let navItem: NavItem | undefined
    this.nav?.toc.forEach((item) =>
      dfs(item as NavItem, (i) => {
        if (compareHref(sectionHref, i.href)) navItem ??= i
      }),
    )
    return navItem
  }

  getSectionTitle(section = this.section, href = section?.href) {
    const navTitle =
      section?.navitem?.label.trim() ||
      (href && this.mapSectionToNavItem(href)?.label.trim())
    if (navTitle) return navTitle

    const headings = [...(section?.document.querySelectorAll('h1,h2,h3') ?? [])]
      .map((heading) => heading.textContent?.replace(/\s+/g, ' ').trim())
      .filter((heading): heading is string => !!heading)

    const firstHeading = headings[0]
    if (firstHeading) {
      const isShortChapterHeading =
        /^(chapter|part|book)\b/i.test(firstHeading) &&
        firstHeading.split(/\s+/).length <= 3

      if (isShortChapterHeading && headings[1]) {
        return `${firstHeading} ${headings[1]}`
      }
      return firstHeading
    }

    return section?.document.title.trim() || href
  }

  get currentHref() {
    return this.location?.start.href
  }

  get currentNavItem() {
    return this.section?.navitem
  }

  get view() {
    return this.rendition?.manager?.views._views[0]
  }

  getNavPath(navItem = this.currentNavItem) {
    const path: INavItem[] = []

    if (this.nav) {
      while (navItem) {
        path.unshift(navItem)
        const parentId = navItem.parent
        if (!parentId) {
          navItem = undefined
        } else {
          const index = this.nav.tocById[parentId]!
          navItem = this.nav.getByIndex(parentId, index, this.nav.toc)
        }
      }
    }

    return path
  }

  getNavPathForLocation(href = this.location?.start.href) {
    if (href) {
      const navItem = this.mapSectionToNavItem(href)
      const path = this.getNavPath(navItem)
      if (path.length) return path
    }

    const sectionIndex = this.sections?.findIndex((section) =>
      compareHref(section.href, href),
    )
    if (sectionIndex !== undefined && sectionIndex >= 0) {
      for (let index = sectionIndex; index >= 0; index -= 1) {
        const section = this.sections?.[index]
        const navItem =
          section?.navitem ||
          (section?.href ? this.mapSectionToNavItem(section.href) : undefined)
        const path = this.getNavPath(navItem)
        if (path.length) return path
      }
    }

    return this.getNavPath()
  }

  searchInSection(keyword = this.keyword, section = this.section) {
    if (!section) return

    const subitems = section.find(keyword) as unknown as IMatch[]
    if (!subitems.length) return

    const navItem = section.navitem
    if (navItem) {
      const path = this.getNavPath(navItem)
      path.pop()
      return {
        id: navItem.href,
        excerpt: navItem.label,
        description: path.map((i) => i.label).join(' / '),
        subitems: subitems.map((i) => ({ ...i, id: i.cfi! })),
        expanded: true,
      }
    }
  }

  search(keyword = this.keyword) {
    // avoid blocking input
    return new Promise<IMatch[] | undefined>((resolve) => {
      requestIdleCallback(() => {
        if (!keyword) {
          resolve(undefined)
          return
        }

        const results: IMatch[] = []

        this.sections?.forEach((s) => {
          const result = this.searchInSection(keyword, s)
          if (result) results.push(result)
        })

        resolve(results)
      })
    })
  }

  private _el?: HTMLDivElement
  onRender?: () => void
  async render(el: HTMLDivElement) {
    if (el === this._el) return
    this._el = ref(el)

    const file = await db?.files.get(this.book.id)
    if (!file) return

    this.epub = ref(await fileToEpub(file.file))
    void this.populateMissingBookmarkPercentages()

    this.epub.loaded.navigation.then((nav) => {
      this.nav = nav
    })
    console.log(this.epub)
    this.epub.loaded.spine.then((spine: any) => {
      const sections = spine.spineItems as ISection[]
      // https://github.com/futurepress/epub.js/issues/887#issuecomment-700736486
      const promises = sections.map((s) =>
        s.load(this.epub?.load.bind(this.epub)),
      )

      Promise.all(promises).then(() => {
        sections.forEach((s) => {
          s.length = s.document.body.textContent?.length ?? 0
          s.images = [...s.document.querySelectorAll('img')].map((el) => el.src)
          this.epub!.loaded.navigation.then(() => {
            s.navitem = this.mapSectionToNavItem(s.href)
          })
        })
        this.sections = ref(sections)
      })
    })
    this.rendition = ref(
      this.epub.renderTo(el, {
        width: '100%',
        height: '100%',
        allowScriptedContent: true,
      }),
    )
    console.log(this.rendition)
    this.rendition.display(
      this.location?.start.cfi ?? this.book.cfi ?? undefined,
    )
    this.rendition.themes.default(defaultStyle)
    this.rendition.hooks.render.register((view: any) => {
      console.log('hooks.render', view)
      this.onRender?.()
    })

    this.rendition.on('relocated', (loc: Location) => {
      console.log('relocated', loc)
      this.rendered = true
      this.timeline.unshift({
        location: loc,
        timestamp: Date.now(),
      })

      // calculate percentage
      if (this.sections) {
        const start = loc.start
        const i = this.sections.findIndex((s) => s.href === start.href)
        const previousSectionsLength = this.sections
          .slice(0, i)
          .reduce((acc, s) => acc + s.length, 0)
        const previousSectionsPercentage =
          previousSectionsLength / this.totalLength
        const currentSectionPercentage =
          this.sections[i]!.length / this.totalLength
        const displayedPercentage = start.displayed.page / start.displayed.total

        const percentage =
          previousSectionsPercentage +
          currentSectionPercentage * displayedPercentage

        this.updateBook({ cfi: start.cfi, percentage })
      }
    })

    this.rendition.on('attached', (...args: any[]) => {
      console.log('attached', args)
    })
    this.rendition.on('started', (...args: any[]) => {
      console.log('started', args)
    })
    this.rendition.on('displayed', (...args: any[]) => {
      console.log('displayed', args)
    })
    this.rendition.on('rendered', (section: ISection, view: any) => {
      console.log('rendered', [section, view])
      this.section = ref(section)
      this.iframe = ref(view.window as Window)
    })
    this.rendition.on('selected', (...args: any[]) => {
      console.log('selected', args)
    })
    this.rendition.on('removed', (...args: any[]) => {
      console.log('removed', args)
    })
  }

  constructor(public book: BookRecord) {
    super(book.id, book.name)

    // don't subscribe `db.books` in `constructor`, it will
    // 1. update the unproxied instance, which is not reactive
    // 2. update unnecessary state (e.g. percentage) of all tabs with the same book
  }
}

class PageTab extends BaseTab {
  constructor(public readonly Component: React.FC<any>) {
    super(Component.displayName ?? 'untitled')
  }
}

type Tab = BookTab | PageTab
type TabParam = ConstructorParameters<typeof BookTab | typeof PageTab>[0]

export class Group {
  id = uuidv4()
  tabs: Tab[] = []

  constructor(
    tabs: Array<Tab | TabParam> = [],
    public selectedIndex = tabs.length - 1,
  ) {
    this.tabs = tabs.map((t) => {
      if (t instanceof BookTab || t instanceof PageTab) return t
      const isPage = typeof t === 'function'
      return isPage ? new PageTab(t) : new BookTab(t)
    })
  }

  get selectedTab() {
    return this.tabs[this.selectedIndex]
  }

  get bookTabs() {
    return this.tabs.filter((t) => t instanceof BookTab) as BookTab[]
  }

  removeTab(index: number) {
    const tab = this.tabs.splice(index, 1)
    this.selectedIndex = updateIndex(this.tabs, index)
    return tab[0]
  }

  addTab(param: TabParam | Tab) {
    const isTab = param instanceof BookTab || param instanceof PageTab
    const isPage = typeof param === 'function'

    const id = isTab ? param.id : isPage ? param.displayName : param.id

    const index = this.tabs.findIndex((t) => t.id === id)
    if (index > -1) {
      this.selectTab(index)
      return this.tabs[index]
    }

    const tab = isTab ? param : isPage ? new PageTab(param) : new BookTab(param)

    this.tabs.splice(++this.selectedIndex, 0, tab)
    return tab
  }

  replaceTab(param: TabParam, index = this.selectedIndex) {
    this.addTab(param)
    this.removeTab(index)
  }

  selectTab(index: number) {
    this.selectedIndex = index
  }
}

export class Reader {
  groups: Group[] = []
  focusedIndex = -1

  get focusedGroup() {
    return this.groups[this.focusedIndex]
  }

  get focusedTab() {
    return this.focusedGroup?.selectedTab
  }

  get focusedBookTab() {
    return this.focusedTab instanceof BookTab ? this.focusedTab : undefined
  }

  addTab(param: TabParam | Tab, groupIdx = this.focusedIndex) {
    let group = this.groups[groupIdx]
    if (group) {
      this.focusedIndex = groupIdx
    } else {
      group = this.addGroup([])
    }
    return group.addTab(param)
  }

  removeTab(index: number, groupIdx = this.focusedIndex) {
    const group = this.groups[groupIdx]
    if (group?.tabs.length === 1) {
      this.removeGroup(groupIdx)
      return group.tabs[0]
    }
    return group?.removeTab(index)
  }

  replaceTab(
    param: TabParam,
    index = this.focusedIndex,
    groupIdx = this.focusedIndex,
  ) {
    const group = this.groups[groupIdx]
    group?.replaceTab(param, index)
  }

  removeGroup(index: number) {
    this.groups.splice(index, 1)
    this.focusedIndex = updateIndex(this.groups, index)
  }

  addGroup(tabs: Array<Tab | TabParam>, index = this.focusedIndex + 1) {
    const group = proxy(new Group(tabs))
    this.groups.splice(index, 0, group)
    this.focusedIndex = index
    return group
  }

  selectGroup(index: number) {
    this.focusedIndex = index
  }

  clear() {
    this.groups = []
    this.focusedIndex = -1
  }

  resize() {
    this.groups.forEach(({ bookTabs }) => {
      bookTabs.forEach(({ rendition }) => {
        try {
          rendition?.resize()
        } catch (error) {
          console.error(error)
        }
      })
    })
  }
}

export const reader = proxy(new Reader())

subscribe(reader, () => {
  console.log(snapshot(reader))
})

export function useReaderSnapshot() {
  return useSnapshot(reader)
}

declare global {
  interface Window {
    reader: Reader
  }
}

if (!IS_SERVER) {
  window.reader = reader
}
