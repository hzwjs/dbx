import { layer, RectangleMarker, type EditorView } from "@codemirror/view";

function getLineElement(view: EditorView, pos: number): HTMLElement | null {
  try {
    const domAt = view.domAtPos(pos);
    let node: Node | null = domAt.node;
    while (node) {
      if (node instanceof HTMLElement && node.classList.contains("cm-line")) return node;
      node = node.parentElement;
    }
  } catch {
    // domAtPos may throw for positions outside the viewport
  }
  return null;
}

export function vscodeSelectionLayer() {
  return layer({
    above: false,
    class: "cm-vscodeSelectionLayer",
    markers(view) {
      const markers: InstanceType<typeof RectangleMarker>[] = [];
      const contentRect = view.contentDOM.getBoundingClientRect();
      const baseRect = view.scrollDOM.getBoundingClientRect();
      const base = {
        left: baseRect.left - view.scrollDOM.scrollLeft * view.scaleX,
        top: baseRect.top - view.scrollDOM.scrollTop * view.scaleY,
      };
      const lineElt = view.contentDOM.querySelector(".cm-line");
      const lineStyle = lineElt && window.getComputedStyle(lineElt);
      const contentLeft =
        contentRect.left +
        (lineStyle ? parseInt(lineStyle.paddingLeft) + Math.min(0, parseInt(lineStyle.textIndent)) : 0);
      // single character width for empty-line fallback
      const sampleCoords = view.coordsAtPos(view.viewport.from);
      const charWidth = sampleCoords ? sampleCoords.right - sampleCoords.left : 8;
      for (const r of view.state.selection.ranges) {
        if (r.empty) continue;
        const fromLine = view.lineBlockAt(r.from);
        const toLine = view.lineBlockAt(r.to);
        for (let pos = fromLine.from; pos <= toLine.from; ) {
          const line = view.lineBlockAt(pos);
          const lineEl = getLineElement(view, line.from);
          if (!lineEl) break;
          const lineRect = lineEl.getBoundingClientRect();
          let left = contentLeft - base.left;
          let right: number;
          const isFirst = line.from === fromLine.from;
          const isLast = line.from === toLine.from;
          if (isFirst) {
            const c = view.coordsAtPos(r.from);
            if (c) left = c.left - base.left;
          }
          if (isLast) {
            const c = view.coordsAtPos(r.to);
            right = c ? c.left - base.left : contentLeft - base.left;
          } else {
            // not the last line: measure text content width from DOM
            const range = document.createRange();
            range.selectNodeContents(lineEl);
            const textRect = range.getBoundingClientRect();
            const textRight = textRect.right - base.left;
            right = textRight > left ? textRight : left + charWidth;
          }
          const w = right! - left;
          if (w > 0) {
            markers.push(
              new RectangleMarker(
                "cm-vscodeSelection",
                left,
                lineRect.top - base.top,
                w,
                lineRect.bottom - lineRect.top,
              ),
            );
          }
          if (isLast) break;
          pos = line.to + 1;
          if (pos > view.state.doc.length) break;
        }
      }
      return markers;
    },
    update(update, _dom) {
      return update.docChanged || update.selectionSet || update.viewportChanged;
    },
  });
}
