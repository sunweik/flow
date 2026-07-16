// https://github.com/juliankrispel/use-text-selection

import { useEventListener } from '@literal-ui/hooks'
import { useEffect, useRef, useState } from 'react'

import { isTouchScreen } from '../platform'

import { useForceRender } from './useForceRender'

export function hasSelection(
  selection?: Selection | null,
): selection is Selection {
  return !!selection && selection.rangeCount > 0 && !selection.isCollapsed
}

// https://htmldom.dev/get-the-direction-of-the-text-selection/
export function isForwardSelection(selection: Selection) {
  const anchorNode = selection.anchorNode
  const focusNode = selection.focusNode
  const ownerDocument = anchorNode?.ownerDocument

  if (anchorNode && focusNode && ownerDocument) {
    const range = ownerDocument.createRange()
    range.setStart(anchorNode, selection.anchorOffset)
    range.setEnd(focusNode, selection.focusOffset)

    return !range.collapsed
  }

  return true
}

export function useTextSelection(win?: Window) {
  const [selection, setSelection] = useState<Selection | undefined>()
  const render = useForceRender()
  const selectionEndTimeout = useRef<ReturnType<typeof setTimeout>>()

  const updateSelection = () => {
    if (selectionEndTimeout.current) {
      clearTimeout(selectionEndTimeout.current)
      selectionEndTimeout.current = undefined
    }

    const nextSelection = win?.getSelection()
    if (hasSelection(nextSelection)) {
      // `getSelection()` returns the same live object as its range changes.
      render()
      setSelection(nextSelection)
    } else {
      setSelection(undefined)
    }
  }

  const scheduleSelectionUpdate = () => {
    if (selectionEndTimeout.current) {
      clearTimeout(selectionEndTimeout.current)
    }
    selectionEndTimeout.current = setTimeout(updateSelection, 250)
  }

  // `selectionchange` covers touch and keyboard selection. `mouseup` keeps the
  // mouse path responsive, including releases in the parent document.
  useEventListener(win?.document, 'selectionchange', scheduleSelectionUpdate)
  useEventListener(win, 'mouseup', updateSelection)
  useEventListener('mouseup', updateSelection)

  useEffect(() => {
    setSelection(undefined)
    return () => {
      if (selectionEndTimeout.current) {
        clearTimeout(selectionEndTimeout.current)
      }
    }
  }, [win])

  // https://stackoverflow.com/questions/3413683/disabling-the-context-menu-on-long-taps-on-android
  useEventListener(win, 'contextmenu', (e) => {
    if (isTouchScreen) {
      e.preventDefault()
    }
  })

  return [selection, setSelection] as const
}
