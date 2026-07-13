import { StateLayer } from '@literal-ui/core'
import { VscCollapseAll, VscExpandAll } from 'react-icons/vsc'

import {
  useLibrary,
  useList,
  useMobile,
  useTranslation,
} from '@flow/reader/hooks'
import {
  compareHref,
  flatTree,
  INavItem,
  reader,
  useReaderSnapshot,
} from '@flow/reader/models'

import { Row } from '../Row'
import { PaneViewProps, PaneView, Pane } from '../base'

export const TocView: React.FC<PaneViewProps> = (props) => {
  const mobile = useMobile()
  return (
    <PaneView {...props}>
      {mobile || <LibraryPane />}
      <TocPane />
    </PaneView>
  )
}

const LibraryPane: React.FC = () => {
  const books = useLibrary()
  const t = useTranslation('toc')
  return (
    <Pane headline={t('library')} preferredSize={240}>
      {books?.map((book) => (
        <button
          key={book.id}
          className="relative w-full truncate py-1 pl-5 pr-3 text-left"
          title={book.name}
          draggable
          onClick={() => reader.addTab(book)}
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', book.id)
          }}
        >
          <StateLayer />
          {book.name}
        </button>
      ))}
    </Pane>
  )
}

const TocPane: React.FC = () => {
  const t = useTranslation()
  const { focusedBookTab } = useReaderSnapshot()
  const tab = reader.focusedBookTab
  const toc = focusedBookTab?.nav?.toc as INavItem[] | undefined
  const tocRevision = focusedBookTab?.tocRevision
  const rows =
    tocRevision === undefined ? undefined : toc?.flatMap((i) => flatTree(i))
  const expanded = toc?.some((r) => r.expanded)
  const currentHref = focusedBookTab?.location?.start.href
  const navigationReady = !!toc && !!focusedBookTab?.sections
  const currentNavPath = navigationReady
    ? tab?.getNavPathForLocation(currentHref) ?? []
    : []
  const currentNavItem = currentNavPath[currentNavPath.length - 1]

  const { outerRef, innerRef, items, scrollToItem } = useList(rows)

  return (
    <Pane
      headline={t('toc.title')}
      ref={outerRef}
      actions={[
        {
          id: expanded ? 'collapse-all' : 'expand-all',
          title: t(expanded ? 'action.collapse_all' : 'action.expand_all'),
          Icon: expanded ? VscCollapseAll : VscExpandAll,
          handle() {
            reader.focusedBookTab?.setAllNavItemsExpanded(!expanded)
          },
        },
      ]}
    >
      {rows && (
        <div ref={innerRef}>
          {items.map(({ index }) => (
            <TocRow
              key={index}
              currentNavItem={currentNavItem}
              item={rows[index]}
              onActivate={() => scrollToItem(index)}
            />
          ))}
        </div>
      )}
    </Pane>
  )
}

interface TocRowProps {
  currentNavItem?: INavItem
  item?: INavItem
  onActivate: () => void
}
const TocRow: React.FC<TocRowProps> = ({
  currentNavItem,
  item,
  onActivate,
}) => {
  if (!item) return null
  const { label, subitems, depth, expanded, id, href } = item
  const tab = reader.focusedBookTab

  return (
    <Row
      title={label.trim()}
      depth={depth}
      active={id === currentNavItem?.id}
      expanded={expanded}
      subitems={subitems}
      onClick={() => {
        const [, id] = href.split('#')
        const section = tab?.sections?.find((s) => compareHref(s.href, href))

        if (!section) return

        if (id) {
          tab?.displayFromSelector(`#${id}`, section, false)
        } else {
          tab?.display(section.href, false)
        }
      }}
      // `tab` can not be proxy here
      toggle={() => tab?.toggle(id)}
      onActivate={onActivate}
    />
  )
}
