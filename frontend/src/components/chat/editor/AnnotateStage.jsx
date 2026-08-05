import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Plus, Trash2 } from 'lucide-react';
import {
  BOX_FRAME_DEFAULT,
  BOX_FRAME_MAX,
  BOX_FRAME_MIN,
  FONT_FRAME_DEFAULT,
  FONT_FRAME_MAX,
  FONT_FRAME_MIN,
  PEN_SIZES,
  TEXT_FONT_STACK,
  TEXT_LINE_HEIGHT,
  applyEditTransform,
  boxWidthForFrame,
  clamp,
  drawStrokes,
  fontSizeForFrame,
  frameBoxFraction,
  frameFontFraction,
  framePointToSource,
  hexWithAlpha,
  isQuarterTurned,
  makeText,
  measureTextBox,
  penWidthForFrame,
  sourcePointToFrame,
} from '../../../utils/mediaEdit';
import {
  Chip,
  ColorSlider,
  EditedCanvas,
  PenSizeRow,
  SwatchRow,
  ToolButton,
  ValueSlider,
  capturePointer,
  outputForDisplay,
  releasePointer,
  useFittedBox,
} from './editorKit';

/**
 * Freehand drawing and text boxes, on the frame that will actually be sent.
 *
 * ## Three layers, and why
 *
 * 1. `EditedCanvas` — the composite, drawn by the SAME `drawEdit` the exporter
 *    uses. The text lives on this canvas rather than in DOM, so its wrapping and
 *    metrics cannot disagree with the bytes that get uploaded. WYSIWYG is not a
 *    nicety here: a caption that reflows between being placed and being sent is
 *    worse than no caption tool.
 * 2. A live-stroke canvas — only the stroke currently under the finger, painted
 *    imperatively. React state is untouched during a stroke. Pushing every
 *    pointermove through `setState` would repaint the whole base image sixty
 *    times a second for no benefit, and would turn one stroke into fifty undo
 *    steps.
 * 3. Transparent DOM boxes over each text item, carrying selection, drag, resize,
 *    delete and the caret. They can be plain axis-aligned divs because
 *    `drawTexts` keeps text upright in output space (see its comment), so nothing
 *    here needs a CSS rotation to line up with the glyphs.
 *
 * ## Colour
 *
 * One vertical strip drives whichever colour is in play: the pen, or the selected
 * box's text, or the selected box's plate. That is what makes "the colour of the
 * text and the text box, individually" two taps rather than two pickers
 * competing for the same edge of the screen.
 *
 * ## What undo covers
 *
 * Structural changes — a finished stroke, adding or deleting a box, a completed
 * drag. Not the colour and size sliders: they are continuous, so every tick would
 * be its own step and Undo would stop meaning anything. Dragging a slider back is
 * the undo for a slider.
 */

/**
 * A context used only for `measureText`.
 *
 * Module-level and 1×1: text metrics do not depend on canvas size, and measuring
 * against the live preview instead would mean the layout the DOM handles are
 * sized from could change under them mid-repaint.
 */
let measureCtx = null;
const measuringContext = () => {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    measureCtx = canvas.getContext('2d');
  }
  return measureCtx;
};

const maxDpr = () => Math.min(2, window.devicePixelRatio || 1);

/**
 * How close together two taps on the same box must land to mean "type in this".
 *
 * A single tap never opens the caret, whatever the selection happened to be. The
 * alternative — "a tap on an already-selected box edits it" — reads well until a box
 * is selected for a reason the user did not choose: the one they just added is
 * selected, so their first attempt to nudge it would raise the keyboard over the
 * picture instead of moving it. Requiring a deliberate double-tap means a tap is
 * always safe to use for picking something up.
 */
const DOUBLE_TAP_MS = 350;

const ALIGNMENTS = [
  { key: 'left', icon: AlignLeft, label: 'Align left' },
  { key: 'center', icon: AlignCenter, label: 'Align centre' },
  { key: 'right', icon: AlignRight, label: 'Align right' },
];

export const AnnotateStage = ({
  image,
  sourceWidth,
  sourceHeight,
  edit,
  onEdit,
  onCommit,
  tool,
  ink,
  onInk,
  penKey,
  onPenKey,
  selectedId,
  onSelect,
}) => {
  const frameAspect = useMemo(() => {
    const cropW = (edit.crop ? edit.crop.w : 1) * sourceWidth;
    const cropH = (edit.crop ? edit.crop.h : 1) * sourceHeight;
    return isQuarterTurned(edit) ? cropH / cropW : cropW / cropH;
  }, [edit, sourceWidth, sourceHeight]);

  const { ref: stageRef, box } = useFittedBox(frameAspect, 16);

  /**
   * Which box has the caret — as state (it drives rendering) plus a ref that is written
   * in the same breath, so any handler can read the CURRENT value without having to
   * reach for it from inside a `setEditingId` updater.
   *
   * That distinction is the whole reason the ref exists. `stopEditing` used to call
   * `onEdit` from inside the updater, and React may run an updater during render — both
   * eagerly, to see whether it can bail out, and again when an update queue is
   * re-processed. So a parent dispatch happened mid-render of this component ("Cannot
   * update a component while rendering a different component"), and it happened a
   * variable number of times. That is the same class of bug as the original undo defect,
   * where history was pushed from inside a `setEdit` updater: a side effect in an
   * updater is not a side effect that runs once.
   */
  const [editingId, setEditingIdState] = useState(null);
  const editingIdRef = useRef(null);
  const setEditingId = useCallback((value) => {
    const next = typeof value === 'function' ? value(editingIdRef.current) : value;
    editingIdRef.current = next;
    setEditingIdState(next);
  }, []);
  /** Which colour the strip and the swatches are driving right now. */
  const [colorTarget, setColorTarget] = useState('text');

  const overlayRef = useRef(null);
  const liveRef = useRef(null);
  const dragRef = useRef(null);
  const textareaRef = useRef(null);
  /** `{ id, at }` of the last tap that landed on a box — the double-tap detector. */
  const lastTapRef = useRef(null);

  const texts = edit.texts || [];
  const selected = texts.find((t) => t.id === selectedId) || null;

  /** Display pixels per source pixel, plus the descriptor overlays draw through. */
  const output = useMemo(
    () => (box.width ? outputForDisplay(sourceWidth, sourceHeight, edit, box.width, box.height) : null),
    [sourceWidth, sourceHeight, edit, box.width, box.height]
  );

  const patchText = useCallback((id, patch) => {
    onEdit((prev) => ({
      ...prev,
      texts: prev.texts.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  }, [onEdit]);

  /**
   * Leaving the caret drops a box nobody typed in.
   *
   * Without this, tapping Add text and then tapping away would leave an invisible
   * empty box in the model — which `hasEdits` counts, so the item would be badged
   * as edited and Revert would appear to have something to undo.
   */
  const stopEditing = useCallback(() => {
    const current = editingIdRef.current;
    if (!current) return;
    // Two plain calls, both from the event or effect that asked for them — NOT one
    // nested inside the other's updater. See the note on `editingIdRef`.
    setEditingId(null);
    onEdit((prev) => {
      const item = prev.texts.find((t) => t.id === current);
      if (item && !item.text.trim()) {
        return { ...prev, texts: prev.texts.filter((t) => t.id !== current) };
      }
      return prev;
    });
  }, [onEdit, setEditingId]);

  // Switching to the pen closes the caret — typing while the pen is selected has
  // nowhere to go. The SELECTION is deliberately kept: a text box stays movable,
  // resizable and deletable with the pen active, so captions can be arranged
  // without going back to the Text tool for every nudge.
  useEffect(() => {
    if (tool !== 'text') stopEditing();
  }, [tool, stopEditing]);

  useEffect(() => {
    if (!editingId) return;
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    const length = node.value.length;
    try { node.setSelectionRange(length, length); } catch { /* before layout */ }
  }, [editingId]);

  // ── The live stroke ───────────────────────────────────────────────────────

  const paintLive = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const stroke = liveRef.current;
    if (!stroke || stroke.points.length === 0) return;
    const pixelOutput = outputForDisplay(sourceWidth, sourceHeight, edit, canvas.width, canvas.height);
    ctx.save();
    applyEditTransform(ctx, sourceWidth, sourceHeight, edit, pixelOutput);
    drawStrokes(ctx, [stroke], sourceWidth, sourceHeight);
    ctx.restore();
  }, [sourceWidth, sourceHeight, edit]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !box.width || !box.height) return;
    const dpr = maxDpr();
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    paintLive();
  }, [box.width, box.height, paintLive]);

  /** Pointer position → normalised SOURCE coordinates. */
  const pointToSource = useCallback((event, rect) => ({
    ...framePointToSource({
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    }, edit),
  }), [edit]);

  const onSurfaceDown = (event) => {
    if (tool !== 'draw') {
      // A tap on bare picture in text mode means "nothing is selected".
      stopEditing();
      onSelect(null);
      return;
    }
    // Starting a stroke also clears the selection, so the handles and outline of a
    // previously-picked box are not left floating over the drawing. This only runs
    // for a pointerdown on bare picture — a box stops propagation, so grabbing one
    // never lands here.
    stopEditing();
    if (selectedId) onSelect(null);
    event.preventDefault();
    capturePointer(event);
    const rect = event.currentTarget.getBoundingClientRect();
    const pen = PEN_SIZES.find((p) => p.key === penKey) || PEN_SIZES[1];
    liveRef.current = {
      id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      color: ink,
      width: penWidthForFrame(pen.fraction, edit, sourceWidth, sourceHeight),
      points: [pointToSource(event, rect)],
    };
    paintLive();
  };

  const onSurfaceMove = (event) => {
    if (!liveRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const next = pointToSource(event, rect);
    const points = liveRef.current.points;
    const last = points[points.length - 1];
    // Drop samples that land on the previous one: a stationary finger emits a
    // steady stream of identical coalesced events, and thousands of duplicate
    // points make the stroke expensive to redraw for no visual difference.
    if (last && Math.abs(last.x - next.x) < 0.0004 && Math.abs(last.y - next.y) < 0.0004) return;
    points.push(next);
    paintLive();
  };

  const onSurfaceUp = (event) => {
    const stroke = liveRef.current;
    if (!stroke) return;
    releasePointer(event);
    liveRef.current = null;
    paintLive();
    onCommit?.();
    onEdit((prev) => ({ ...prev, strokes: [...prev.strokes, stroke] }));
  };

  // ── Text geometry ─────────────────────────────────────────────────────────

  /**
   * Where a text box sits on screen, in CSS pixels of the stage.
   *
   * Axis-aligned, because `drawTexts` counter-rotates the glyphs — so the box's
   * own axes are the display's axes whatever the image's rotation is.
   */
  const boxRect = useCallback((item) => {
    if (!output) return null;
    const layout = measureTextBox(measuringContext(), item, sourceWidth, sourceHeight);
    const centre = sourcePointToFrame({ x: item.x, y: item.y }, edit);
    const width = layout.boxWidth * output.scale;
    const height = layout.boxHeight * output.scale;
    return {
      layout,
      width,
      height,
      left: centre.x * box.width - width / 2,
      top: centre.y * box.height - height / 2,
    };
  }, [output, sourceWidth, sourceHeight, edit, box.width, box.height]);

  const addText = () => {
    const centre = framePointToSource({ x: 0.5, y: 0.5 }, edit);
    const item = makeText({
      x: centre.x,
      y: centre.y,
      fontSize: fontSizeForFrame(FONT_FRAME_DEFAULT, edit, sourceHeight, sourceWidth),
      boxWidth: boxWidthForFrame(BOX_FRAME_DEFAULT, edit, sourceWidth, sourceHeight),
      padding: fontSizeForFrame(0.018, edit, sourceHeight, sourceWidth),
      color: ink,
    });
    onCommit?.();
    onEdit((prev) => ({ ...prev, texts: [...prev.texts, item] }));
    onSelect(item.id);
    setEditingId(item.id);
    setColorTarget('text');
  };

  const removeText = (id) => {
    onCommit?.();
    onEdit((prev) => ({ ...prev, texts: prev.texts.filter((t) => t.id !== id) }));
    if (selectedId === id) onSelect(null);
    if (editingId === id) setEditingId(null);
  };

  // ── Move and resize ──────────────────────────────────────────────────────

  /**
   * Start a move or a resize. Works with EITHER tool selected.
   *
   * It used to return early unless the Text tool was active, which meant a caption
   * could not be nudged, resized or retyped without first going back to the tool
   * picker — the pen made every text box inert. Boxes are now grabbable whenever
   * the annotate stage is up.
   *
   * The trade that buys: with the pen active, a stroke can no longer START on top of
   * a caption, because the box takes that pointerdown. Drawing THROUGH one still
   * works — begin the stroke on bare picture and cross it — and being able to move
   * the thing you can see is worth more than starting a line inside its bounds.
   */
  const beginDrag = (item, mode) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    capturePointer(event);
    const rect = boxRect(item);
    dragRef.current = {
      id: item.id,
      mode,
      origin: { x: event.clientX, y: event.clientY },
      centre: sourcePointToFrame({ x: item.x, y: item.y }, edit),
      startWidthPx: rect ? rect.width : 0,
      padPx: item.padding * sourceHeight,
      moved: false,
    };
    onSelect(item.id);
  };

  const onDragMove = (event) => {
    const drag = dragRef.current;
    if (!drag || !output || !box.width || !box.height) return;
    const dx = event.clientX - drag.origin.x;
    const dy = event.clientY - drag.origin.y;
    // One history entry per gesture, pushed the moment it stops being a tap.
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) <= 3) return;
      drag.moved = true;
      onCommit?.();
    }

    if (drag.mode === 'move') {
      patchText(drag.id, framePointToSource({
        x: clamp(drag.centre.x + dx / box.width, 0, 1),
        y: clamp(drag.centre.y + dy / box.height, 0, 1),
      }, edit));
      return;
    }

    // Resize changes the WRAP WIDTH only, never the type size — two independent
    // controls is the point. The box is centre-anchored, so a handle moved by dx
    // grows the box by 2dx; and because it is axis-aligned in display space the
    // conversion back to a source fraction carries no rotation term.
    const nextWidthPx = Math.max(8, drag.startWidthPx + dx * 2);
    const contentSourcePx = nextWidthPx / output.scale - 2 * drag.padPx;
    patchText(drag.id, {
      boxWidth: clamp(
        contentSourcePx / sourceWidth,
        boxWidthForFrame(BOX_FRAME_MIN, edit, sourceWidth, sourceHeight),
        boxWidthForFrame(BOX_FRAME_MAX, edit, sourceWidth, sourceHeight)
      ),
    });
  };

  const endDrag = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    releasePointer(event);
    dragRef.current = null;
    if (drag.moved || drag.mode !== 'move') return;

    // A tap, not a drag:
    //
    //   single tap  — select. The box is now movable, resizable and deletable, and the
    //                 finger is already on it so a drag continues naturally.
    //   double tap  — open the caret.
    //
    // A single tap used to go straight to the caret, which made a box impossible to
    // simply pick up: touching it to move it raised the keyboard, and the keyboard
    // covered the picture being annotated. See DOUBLE_TAP_MS for why this is a real
    // double-tap rather than "a tap on whatever was already selected".
    const now = Date.now();
    const previous = lastTapRef.current;
    if (previous && previous.id === drag.id && now - previous.at < DOUBLE_TAP_MS) {
      lastTapRef.current = null;
      setEditingId(drag.id);
      return;
    }
    lastTapRef.current = { id: drag.id, at: now };
  };

  // ── Colour routing ───────────────────────────────────────────────────────

  const activeColor = tool === 'draw'
    ? ink
    : selected
      ? (colorTarget === 'box' ? selected.boxColor : selected.color)
      : ink;

  const setActiveColor = (hex) => {
    if (tool === 'draw' || !selected) { onInk(hex); return; }
    patchText(selected.id, colorTarget === 'box' ? { boxColor: hex } : { color: hex });
    // Kept as the pen colour too, so the next stroke picks up the colour the user
    // has just been thinking about rather than reverting to an older one.
    if (colorTarget === 'text') onInk(hex);
  };

  // ── The in-place caret ───────────────────────────────────────────────────

  const editing = texts.find((t) => t.id === editingId) || null;
  const editingRect = editing ? boxRect(editing) : null;

  return (
    <>
      <div className="flex-1 min-h-0 flex items-stretch">
        <div ref={stageRef} className="flex-1 min-h-0 flex items-center justify-center px-2">
          {box.width > 0 && (
            <div
              className="relative"
              style={{ width: box.width, height: box.height, touchAction: 'none' }}
              data-testid="editor-annotate-stage"
            >
              <EditedCanvas
                image={image}
                sourceWidth={sourceWidth}
                sourceHeight={sourceHeight}
                edit={edit}
                width={box.width}
                height={box.height}
                skipTextId={editingId}
                className="rounded-[4px]"
              />

              {/* Only the stroke currently under the finger. */}
              <canvas
                ref={overlayRef}
                aria-hidden="true"
                className="absolute inset-0 pointer-events-none"
                style={{ width: box.width, height: box.height }}
              />

              {/* The gesture surface. `touch-action: none` is required, not
                  optional: without it the browser's own pan claims the gesture
                  before a pointer event is ever delivered — the same reason
                  FullscreenImageViewer sets it. */}
              <div
                className="absolute inset-0"
                style={{ touchAction: 'none', cursor: tool === 'draw' ? 'crosshair' : 'default' }}
                onPointerDown={onSurfaceDown}
                onPointerMove={onSurfaceMove}
                onPointerUp={onSurfaceUp}
                onPointerCancel={onSurfaceUp}
                data-testid="editor-draw-surface"
              />

              {/* Transparent chrome per text box: the glyphs are on the canvas
                  underneath, these carry the interaction. Live with EITHER tool
                  selected — a caption is movable and retypable without going back to
                  the Text tool. Inert only for the box currently holding the caret,
                  where the textarea on top owns the pointer. */}
              {texts.map((item) => {
                const rect = boxRect(item);
                if (!rect) return null;
                const isSelected = item.id === selectedId;
                const isEditing = item.id === editingId;
                return (
                  <div
                    key={item.id}
                    className="absolute"
                    style={{
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                      height: rect.height,
                      pointerEvents: isEditing ? 'none' : 'auto',
                      touchAction: 'none',
                      cursor: 'move',
                      outline: isSelected && !isEditing ? '1px dashed rgba(255,255,255,0.85)' : 'none',
                      outlineOffset: '2px',
                    }}
                    onPointerDown={beginDrag(item, 'move')}
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    data-testid="editor-text-box"
                  >
                    {isSelected && !isEditing && (
                      <>
                        <span
                          role="button"
                          tabIndex={-1}
                          aria-label="Resize text box"
                          data-testid="editor-text-resize"
                          onPointerDown={beginDrag(item, 'resize')}
                          onPointerMove={onDragMove}
                          onPointerUp={endDrag}
                          onPointerCancel={endDrag}
                          className="absolute -right-3 -bottom-3 w-7 h-7 rounded-full flex items-center justify-center"
                          style={{ cursor: 'nwse-resize', touchAction: 'none' }}
                        >
                          <span className="w-3 h-3 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.7)]" />
                        </span>
                        <button
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); removeText(item.id); }}
                          aria-label="Delete this text"
                          data-testid="editor-text-delete"
                          className="absolute -right-3 -top-3 w-7 h-7 rounded-full bg-black/70 text-white flex items-center justify-center hover:bg-[#EF4444] transition-colors"
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}

              {/* The caret. Styled from the same layout the canvas uses, so the
                  glyphs do not jump when editing ends. */}
              {editing && editingRect && (
                <textarea
                  ref={textareaRef}
                  value={editing.text}
                  onChange={(event) => patchText(editing.id, { text: event.target.value })}
                  onBlur={stopEditing}
                  onKeyDown={(event) => {
                    // Escape leaves the caret. Enter inserts a newline — a text
                    // box on a photo is frequently two lines, and there is a
                    // Done button two inches away for finishing.
                    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); stopEditing(); }
                  }}
                  spellCheck={false}
                  className="absolute resize-none border-0 outline-none overflow-hidden"
                  data-testid="editor-text-input"
                  style={{
                    left: editingRect.left,
                    top: editingRect.top,
                    width: editingRect.width,
                    height: editingRect.height,
                    padding: editingRect.layout.pad * output.scale,
                    fontFamily: TEXT_FONT_STACK,
                    fontWeight: 600,
                    fontSize: editingRect.layout.fontPx * output.scale,
                    lineHeight: TEXT_LINE_HEIGHT,
                    color: editing.color,
                    textAlign: editing.align,
                    background: editing.boxOpacity > 0
                      ? hexWithAlpha(editing.boxColor, editing.boxOpacity)
                      : 'transparent',
                    borderRadius: editingRect.layout.pad * 0.9 * output.scale,
                    caretColor: editing.color,
                    wordBreak: 'break-word',
                    whiteSpace: 'pre-wrap',
                  }}
                />
              )}
            </div>
          )}
        </div>

        {/* The colour strip lives beside the picture, not under it: it is the one
            control the user reaches for repeatedly while drawing, and a bottom bar
            would put it under their own hand on a touchscreen. */}
        <div className="flex-shrink-0 flex items-center justify-center pl-1 pr-3">
          <div className="h-[55%] min-h-[140px] max-h-[300px] flex items-center">
            <ColorSlider value={activeColor} onChange={setActiveColor} />
          </div>
        </div>
      </div>

      {/* Bottom controls */}
      <div className="flex-shrink-0 px-3 pb-3 pt-2 space-y-2">
        {tool === 'draw' ? (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <PenSizeRow value={penKey} onChange={onPenKey} color={ink} />
            <SwatchRow value={ink} onChange={onInk} />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <ToolButton icon={Plus} label="Add a text box" onClick={addText} testId="editor-add-text">
                Add text
              </ToolButton>

              {selected ? (
                <>
                  <span className="w-px h-6 bg-white/15" />
                  {/* The two colours, individually. */}
                  <Chip
                    label="Text"
                    active={colorTarget === 'text'}
                    onClick={() => setColorTarget('text')}
                    testId="editor-color-target-text"
                    title="The colour strip sets the text colour"
                  />
                  <Chip
                    label="Box"
                    active={colorTarget === 'box'}
                    onClick={() => setColorTarget('box')}
                    testId="editor-color-target-box"
                    title="The colour strip sets the box colour"
                  />
                  <span className="w-px h-6 bg-white/15" />
                  {ALIGNMENTS.map((a) => (
                    <ToolButton
                      key={a.key}
                      icon={a.icon}
                      label={a.label}
                      size={15}
                      active={selected.align === a.key}
                      onClick={() => patchText(selected.id, { align: a.key })}
                      testId={`editor-align-${a.key}`}
                    />
                  ))}
                  {/* No flex spacer before it: on a phone the row wraps, and a
                      spacer would strand an unlabelled destructive button alone on
                      a line of its own. */}
                  <ToolButton
                    icon={Trash2}
                    label="Delete this text"
                    danger
                    onClick={() => removeText(selected.id)}
                    testId="editor-delete-selected-text"
                  />
                </>
              ) : (
                <span className="text-[11px] text-[#525252]">
                  {texts.length > 0
                    ? 'Tap a text box to move or resize it, double-tap to type'
                    : 'Drop a caption anywhere on the picture'}
                </span>
              )}
            </div>

            {selected && (
              <div className="flex items-center gap-4 flex-wrap">
                {/* The two size controls the brief asks to be independent: one
                    scales the glyphs, the other only sets the wrap width. */}
                <div className="flex-1 min-w-[190px]">
                  <ValueSlider
                    label="Text size"
                    testId="editor-text-size"
                    min={FONT_FRAME_MIN}
                    max={FONT_FRAME_MAX}
                    value={frameFontFraction(selected.fontSize, edit, sourceWidth, sourceHeight)}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={(v) => patchText(selected.id, {
                      fontSize: fontSizeForFrame(v, edit, sourceHeight, sourceWidth),
                    })}
                  />
                </div>
                <div className="flex-1 min-w-[190px]">
                  <ValueSlider
                    label="Box width"
                    testId="editor-box-width"
                    min={BOX_FRAME_MIN}
                    max={BOX_FRAME_MAX}
                    value={frameBoxFraction(selected.boxWidth, edit, sourceWidth, sourceHeight)}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={(v) => patchText(selected.id, {
                      boxWidth: boxWidthForFrame(v, edit, sourceWidth, sourceHeight),
                    })}
                  />
                </div>
                <div className="flex-1 min-w-[190px]">
                  {/* 0% is the transparent background this feature is specified
                      around, and it is where every new box starts. */}
                  <ValueSlider
                    label="Box fill"
                    testId="editor-box-opacity"
                    min={0}
                    max={1}
                    value={selected.boxOpacity}
                    format={(v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`)}
                    onChange={(v) => patchText(selected.id, { boxOpacity: v })}
                  />
                </div>
              </div>
            )}

            <SwatchRow value={activeColor} onChange={setActiveColor} />
          </>
        )}
      </div>
    </>
  );
};

export default AnnotateStage;
