/**
 * The VoiceOS Widget Kit — the design system every generated integration
 * builds its cards from.
 *
 * ## Why this file exists
 *
 * A widget is a complete HTML document rendered in a locked sandbox, so before
 * this kit every generated integration hand-rolled its own CSS: its own type
 * scale, its own spacing, its own idea of a list row. Two things followed, both
 * bad. The cards never matched each other or the notch around them, because
 * nothing shared a definition of "a row". And the markup competed for output
 * tokens with the code — a model asked to write a working MCP server AND five
 * kilobytes of CSS spends its budget on the CSS and ships a worse server.
 *
 * So the CSS moved here, once, and the integration writes `vList(items)`.
 * A card costs a few hundred tokens instead of several thousand, every
 * integration inherits the same design language, and restyling all of them at
 * once is an edit to this file.
 *
 * Two entry points share that plumbing:
 *  - {@link renderWidget} — compose prebuilt components. The quick path for a
 *    simple card.
 *  - {@link renderCustom} — hand-authored markup + CSS with full pixel
 *    control, for cards that should look like the real product. The kit still
 *    carries the bridge, the mark, the escaping, and the byte cap.
 *
 * This module is COPIED INTO EVERY GENERATED INTEGRATION FOLDER as
 * `widgetKit.ts`, next to `server.ts`. That is why it has zero imports and
 * zero dependencies: it has to run under whatever bun or tsx the user's
 * machine provides, with nothing installed.
 *
 * ## The constraints it is shaped by
 *
 * - **No network.** The host page's CSP blocks every fetch, image, and font
 *   request from inside the frame. Everything is inline; images must be
 *   `data:` URIs; the font stack is the system one.
 * - **300,000 characters per card**, and 60-420 CSS px tall, on a ~388px-wide column.
 * - **The bridge is the only channel**: `voiceos:init` in (data, args, theme),
 *   `voiceos:resize` / `voiceos:openUrl` / `voiceos:updateInput` out.
 * - **Theme comes from the bridge, never from `prefers-color-scheme`.** The
 *   notch is unconditionally black, so the OS appearance is the wrong signal —
 *   keying off it renders a light card on a black surface for every user whose
 *   Mac is in light mode. `prefers-reduced-motion` IS honoured, because that
 *   one really is a user preference about behaviour.
 * - **The confirm button is not ours.** On a confirmation card VoiceOS floats
 *   its own button over the bottom-right corner, so `mode: "confirm"` reserves
 *   that space and no card may draw its own approve/cancel control.
 * - **The integration's logo is the header's first element.** See
 *   {@link INTEGRATION_MARK} — the card identifies itself the way an app does,
 *   and no integration has to remember to do it.
 * - **The corner is not the card's to choose.** Every VoiceOS card is cut at
 *   the same radius, and the surface does the cutting — so a card that paints
 *   its own background or border writes `border-radius: var(--k-radius)` and
 *   never a number. See {@link WIDGET_KIT_LIMITS}.`surfaceRadius`.
 * - **The surface finish is the kit's, on by default.** Every card gets the
 *   liquid-glass rim (`.k-rim` — a 1px inset hairline with a brighter top
 *   edge, on the same `--k-radius` arc as the host's clip). A card with a
 *   declared accent additionally gets a soft wash of the accent out of the
 *   top-left corner. The mark stays a bare glyph in both cases — never on an
 *   accent tile, a chip, or any invented backdrop; the icon's own artwork is
 *   the identity. Cards draw none of this themselves — a second border or a
 *   hand-made logo tile doubles the chrome.
 */

// ---------------------------------------------------------------------------
// Limits — mirrored from the host's WIDGET_CAPS / the SDK's WIDGET_LIMITS.
// ---------------------------------------------------------------------------

export const WIDGET_KIT_LIMITS = {
  /**
   * HTML length in UTF-16 code units, matching the host validators. Result
   * envelopes also have a 300,000-character JSON budget; leave room for
   * escaping and data when constructing result cards.
   */
  maxHtmlChars: 300_000,
  /** @deprecated Use maxHtmlChars. Kept as an alias for existing integrations. */
  maxHtmlBytes: 300_000,
  minHeight: 60,
  maxHeight: 420,
  defaultHeight: 180,
  /** The bottom-right area VoiceOS's floating confirm button occupies. */
  confirmReserveHeight: 44,
  /**
   * The corner every VoiceOS card is cut at. Host geometry, exactly like
   * `confirmReserveHeight` — the surface a card lands on rounds it, so a card
   * that paints its own background or border has to use THIS radius or its
   * corners sit inside the host's arc and read as a second, misaligned edge.
   *
   * It reaches the document as `--k-radius`, and a host whose own slot cuts
   * differently overrides that variable over the bridge (VoiceOS's pill clips
   * at 25, concentric inside its shell). So card CSS says
   * `border-radius: var(--k-radius)` and is right in every surface; a literal
   * is right in one and wrong in the rest.
   */
  surfaceRadius: 26,
} as const;

export type Tone = "neutral" | "good" | "bad" | "accent";
export type ThemeMode = "dark" | "light";
export type CardMode = "result" | "confirm";

/**
 * A rendered fragment plus what it will cost vertically. Carrying the height
 * with the markup is what lets {@link renderWidget} declare an accurate height
 * up front — a card whose declared height is wrong visibly resizes when it
 * arrives, which reads as broken however good it looks once settled.
 */
export interface Block {
  html: string;
  h: number;
}

type Blockish = Block | null | undefined | false;

// ---------------------------------------------------------------------------
// Text safety
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape anything interpolated into markup.
 *
 * Every string a card renders came from somebody's API, and an API that
 * returns `<script>` in a title is not hypothetical. The sandbox means such a
 * script could not reach VoiceOS or the network, but it would still wreck the
 * card, so nothing is interpolated raw. Control characters are stripped
 * outright: they render as nothing useful and corrupt layout.
 */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return (
    String(value)
      // eslint-disable-next-line no-control-regex -- stripping them is the point
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replace(/[&<>"']/g, (char) => ESCAPES[char])
  );
}

/**
 * Hard character clamp with an ellipsis. CSS handles single-line truncation
 * visually; this keeps one runaway API string from eating the byte budget.
 */
export function clip(value: unknown, max: number): string {
  const text =
    value === null || value === undefined ? "" : String(value).trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Roughly how many ems a string occupies, so wrapping can be predicted for
 * scripts that aren't Latin.
 *
 * Counting characters and dividing works only for English. A Japanese string
 * is about twice as wide per character, so a character-count estimate
 * under-predicts a wrapped Japanese note's height by ~17% — and VoiceOS ships
 * a Japanese UI, so that is a shipped miscalculation, not a hypothetical.
 * These weights are coarse on purpose: they only have to beat "every
 * character is 1".
 */
const WIDE_CHAR = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
const NARROW_CHAR = /[iIl1.,:;'!|[\]()/\\ ]/;

export function textEms(text: string): number {
  let ems = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x1f000)
      ems += 1; // emoji and friends are full-width
    else if (WIDE_CHAR.test(char)) ems += 1;
    else if (NARROW_CHAR.test(char)) ems += 0.3;
    else if (char >= "A" && char <= "Z") ems += 0.68;
    else ems += 0.52;
  }
  return ems;
}

/** https only — exactly what the host is willing to open. */
function safeUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  return /^https:\/\/[^\s"']+$/i.test(trimmed) ? trimmed : null;
}

const toneVar = (tone: Tone | undefined): string =>
  tone === "good"
    ? "var(--good)"
    : tone === "bad"
      ? "var(--bad)"
      : tone === "accent"
        ? "var(--accent)"
        : "var(--ink-1)";

const block = (html: string, h: number): Block => ({ html, h });

/**
 * Per-image budget, as `data:` URI characters — so about three quarters of it
 * in original file bytes.
 *
 * Images are the only unbounded field in a card (the sandbox has no network, so
 * they are inlined), and five rows of full-resolution artwork trivially exceeds
 * the document cap — at which point the host drops the ENTIRE card and
 * the integration looks like it returned nothing. An oversized image is dropped
 * instead: the row keeps its placeholder and everything else survives.
 *
 * Kept deliberately ABOVE `maxHtmlBytes / maxListRows` so that a card full of
 * legitimately-sized artwork can still reach the document cap and exercise the
 * degradation path. When the per-image budget is small enough that no
 * combination of images can overflow the document, that path stops being
 * reachable — and an unreachable fallback is one nobody notices has broken.
 */
const MAX_IMAGE_BYTES = 32_768;
/**
 * One Latin-subset WOFF2 can fit; a full family cannot.
 *
 * This is DATA-URI characters (about 27KB of source font bytes), leaving most
 * of the document for markup, CSS, and one small image. Raising it would
 * make two weights look possible while reliably dropping the finished card.
 */
const MAX_FONT_BYTES = 42_000;

function safeImage(src: unknown): string | null {
  if (typeof src !== "string") return null;
  const trimmed = src.trim();
  if (!/^data:image\//i.test(trimmed)) return null;
  return trimmed.length <= MAX_IMAGE_BYTES ? trimmed : null;
}

/** base64 without a dependency, under either Node/Bun or a plain runtime. */
function toBase64(bytes: Uint8Array): string {
  const nodeBuffer = (globalThis as { Buffer?: any }).Buffer;
  if (nodeBuffer) return nodeBuffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Fetch a remote image and return it as a `data:` URI, or null.
 *
 * ## Why this exists
 *
 * The card sandbox has no network, so `<img src="https://…">` inside a card is
 * always an empty box. But the TOOL HANDLER is ordinary Node with ordinary
 * network access — it can fetch the artwork and hand the card the bytes. That
 * asymmetry was never written down anywhere, so generated cards read the rule
 * as "images are impossible" and shipped without the single most recognisable
 * element most products have: the album art, the avatar, the thumbnail, the
 * favicon of the site being linked.
 *
 * Two things to know before calling it:
 *
 *  - **Ask the API for a SMALL image.** The budget is bytes AFTER base64, so
 *    the original file has to be about three quarters of `maxBytes`. Nearly
 *    every API exposes a size: Spotify returns several entries in `images[]`,
 *    Gravatar and GitHub take `?s=64`, most CDNs take a width parameter. Pick
 *    the smallest that still looks right at its RENDERED size — a 32px row
 *    thumbnail on a 2× display wants 64px, not 640px.
 *  - **It never throws.** A timeout, a 404, an HTML error page, a wrong
 *    content-type, or an oversized file all return null, and the card is
 *    expected to draw its placeholder instead. An integration that fails
 *    because a thumbnail didn't load is worse than one with no thumbnail.
 */
export async function inlineImage(
  url: unknown,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  if (typeof url !== "string") return null;
  const target = url.trim();
  // Already a data: URI — hand it back if it fits, so callers can pass through
  // whatever an API gave them without checking which kind it was.
  if (!/^https?:\/\//i.test(target)) return safeImage(target);

  const maxBytes = Math.max(512, options.maxBytes ?? MAX_IMAGE_BYTES);
  try {
    const response = await fetch(target, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 6_000),
    });
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    // An error page served as HTML is the common failure here, and it would
    // otherwise be inlined as a "data:text/html" image that renders as nothing.
    if (!/^image\/[a-z0-9.+-]+$/.test(type)) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) return null;
    // Check the ENCODED size before spending the work encoding it: base64 is
    // four characters per three bytes, plus the `data:<type>;base64,` prefix.
    if (Math.ceil(bytes.length / 3) * 4 + type.length + 14 > maxBytes)
      return null;
    return `data:${type};base64,${toBase64(bytes)}`;
  } catch {
    return null;
  }
}

function safeFont(src: unknown, maxBytes: number): string | null {
  if (typeof src !== "string") return null;
  const trimmed = src.trim();
  if (!/^data:font\/woff2;base64,/i.test(trimmed)) return null;
  return trimmed.length <= maxBytes ? trimmed : null;
}

/**
 * Fetch one PRE-SUBSETTED WOFF2 in the handler for an inline @font-face.
 *
 * The sandbox cannot load webfonts itself, but a handler can fetch a compact
 * Latin subset just as it fetches artwork. This helper deliberately does not
 * pretend to subset arbitrary font files: doing that needs a font parser and
 * generated integrations ship with zero extra runtime dependencies. Ask the
 * font provider for its existing `latin` WOFF2 and use one weight only.
 *
 * Returns a data URI or null. Callers must keep a system-stack fallback.
 */
export async function inlineFont(
  url: unknown,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const maxBytes = Math.max(1_024, options.maxBytes ?? MAX_FONT_BYTES);
  if (typeof url !== "string") return null;
  const target = url.trim();
  if (!/^https?:\/\//i.test(target)) return safeFont(target, maxBytes);

  try {
    const response = await fetch(target, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 6_000),
    });
    if (!response.ok) return null;
    const declaredType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (
      declaredType &&
      !/^(?:font\/woff2|application\/font-woff2|application\/octet-stream)$/.test(
        declaredType,
      )
    ) {
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    // WOFF2 files begin with the ASCII signature "wOF2". Content-Type alone
    // is not enough: CDNs commonly serve an HTML error as octet-stream.
    if (
      bytes.length < 4 ||
      bytes[0] !== 0x77 ||
      bytes[1] !== 0x4f ||
      bytes[2] !== 0x46 ||
      bytes[3] !== 0x32
    ) {
      return null;
    }
    if (
      Math.ceil(bytes.length / 3) * 4 + "data:font/woff2;base64,".length >
      maxBytes
    ) {
      return null;
    }
    return `data:font/woff2;base64,${toBase64(bytes)}`;
  } catch {
    return null;
  }
}

/**
 * {@link inlineImage} for a list, fetched in parallel and index-aligned with
 * the input so a row can pair its own result with its own data. Rows whose
 * image failed get null and should fall back to a placeholder.
 *
 * The total budget matters as much as the per-image one: five rows of artwork
 * at the per-image cap will still blow the document cap between them, so this
 * stops inlining once the running total would exceed `totalBytes`. Earlier
 * rows win, which is the right order — the top of the card is what gets looked
 * at.
 */
export async function inlineImages(
  urls: unknown[],
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    totalBytes?: number;
  } = {},
): Promise<(string | null)[]> {
  const resolved = await Promise.all(
    (Array.isArray(urls) ? urls : []).map((url) => inlineImage(url, options)),
  );
  const budget = Math.max(
    0,
    options.totalBytes ?? WIDGET_KIT_LIMITS.maxHtmlBytes / 2,
  );
  let spent = 0;
  return resolved.map((uri) => {
    if (!uri) return null;
    if (spent + uri.length > budget) return null;
    spent += uri.length;
    return uri;
  });
}

// ---------------------------------------------------------------------------
// The integration's mark
// ---------------------------------------------------------------------------

/**
 * The integration's own logo, as a `data:` URI, drawn at the top-left of every
 * header.
 *
 * A card that doesn't say whose it is makes the user do the work: mid-
 * conversation, glancing at a 388px surface, "Spotify green" is not an
 * identity. Real apps put their mark in the corner, so every VoiceOS card does
 * too — and because it is the kit that draws it, no generated integration can
 * forget, get it wrong, or spend tokens reinventing it.
 *
 * The value arrives two ways, and neither of them is the integration's job:
 *  - VoiceOS SUBSTITUTES this declaration when it copies the kit into a
 *    generated integration's folder, so `server.ts` gets a kit that already
 *    knows the mark (see lib/main/integrationWidgetMark.ts). The declaration
 *    below is matched verbatim — keep it on one line, exactly as written.
 *  - {@link setIntegrationMark} sets it at runtime, which is how the server
 *    renders confirmation cards with the same mark as the result cards.
 *
 * Empty means "no logo yet": the header falls back to the accent dot, which is
 * what every card looked like before this existed.
 */
let INTEGRATION_MARK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAAXNSR0IArs4c6QAABNBJREFUWIXtlk1IG1sUx++dmBpH04V1kaVVsKAQdFNx4weKICnRjaQpBREXulNcCS6KouC34FZMLQXbNFZMaFM0hWykq+LXRm1XQTdiiC2GMZm5954uznvz8sbPxvTxFvnvcu5kzu/+z5lzLyFZZZVVVllldSdJkpSR+H8hSuml8T/IRCnt6enJzc01pH/w4EF3d/fF3GVlZU+ePCGEmEymP0JDCNna2goGg/Rv4ZIsy4qijI2NGXKXl5cnk8m2tjZCSE5OToaBcPfBYBAA3r59K0mSziTLciQSAYChoSFkwnhpaSljTNM0p9OZeZ8wRygUYowBgM/nQyYEOjw85JwDwPDwsO5HWVmZqqpCCE3TWltbM+wTOrS+vi6EUBQFAJaXlzFYUFAQiUSEEMlkUmeilCIQ55xznnkmNGNjY4Mxpqoq5l5eXqaUyrIci8UYY7gEACMjI4SQiooKAOCcM8Y456qqIlNmaodmjI+PA0AymdT98Pl8hJAPHz5gHBMDwIsXLwghBwcHAKCqKjLpPl01I9JhmpubMzBhj4dCIcwthECmwcHB/Pz8b9++AYCmaTqT0+mklGagdpIkTU9PFxYWTk1NGZiWlpYopciU6lNfX58sy8ikqioGg8Fg6g7vZM/Xr18PDg7MZvPs7KyB6c2bNzoT9rLOpPt0fn4uhHj58mV5ebnD4bhTP2HVcQ5tbm7m5ubOzMxcz6TXrr+/v6CgAJk45x6P5/Hjx4lEora2Nn0mdOjz5884b7a3ty0Wy0Umr9ebWrtUJlmW9/b2AGB+ft5utwPA2dlZXV1dmkzo0NramhDi/PwcAHZ2di71CZnW19cN/dTf32+xWA4PD1dWVux2uxBCCJE+Ezr05csX3DTm2NnZsVgs2ONYI/27o5Sura1d7CebzTY4OFhdXY1L6fuEQJ2dnfgN6zlSmQw+EUL8fr+hnwYGBgghjY2N2E+apqFP9fX1v81kMplycnI6OjoMTLu7u7dh0p/v6uqqqqoCAJxMACCEiMfjDQ0Nv8GEZ/vq6qrdbne5XJcyTU5OGmr3+vVrQkggEEBWxPJ6vZWVlegQAESjUQAAgHg8jj7damZiyTY2NhRFKS4udrvd1zCl+pTKpCiKEGJhYQEdEkJMT08XFRUNDQ3hGRyPxxsbG/WCXDc58Sv79OkTAJyenpaUlDx79iwNJsbY4uIiAgGAy+UihLS0tOBfcHj29vbKsnxzyfT7EOf89PT04cOHT58+1c8pfB3OgomJCf1MTSQSAPDq1StCyPv373EOVVZW4i3g+Ph4fn7+6OgIfzLGhBAA8P37d4/H43a7rzyJ0b1wOKzXXlGUR48ePX/+HP6t/f19q9WKPZ6qd+/eSZIUDocDgQAOxhsVDocNR94/zQUAhJBoNHpycsIYI4SYzeaPHz/W1NR0dXWNjo7iVhhjNpvN7/c3NzdTStvb2znnkiQxxpqamoaHhx0OR1tbm8ViicVinHNCiBBCv/Xq0jTNZDJFIhE99V+FMvgky7LZbAYASqkQ4t69e5zzHz9+WK1WfR+c8/z8/J8/fyYSiby8PHwY4/fv349Go7gZq9WqL10UAEiSlEwm4/H4Dc10VTVvH7/L7eySfxpeh35ezJHqc9pYN74kq6yyyiqr/51+AfCDEFLR6IX4AAAAAElFTkSuQmCC";

/** Point the kit at an integration's logo. Invalid or oversized values clear it. */
export function setIntegrationMark(dataUri: string | null | undefined): void {
  INTEGRATION_MARK = safeImage(dataUri) ?? "";
}

/** The mark the kit will draw, or "" when it has none. */
export function integrationMark(): string {
  return INTEGRATION_MARK;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export interface HeaderOptions {
  /** The integration or view name. Kept short — this is a lead-in, not a title. */
  title: string;
  /** Optional second line, e.g. what the result is scoped to. */
  subtitle?: string;
  /** Right-aligned context: a count, a timestamp, a status. */
  trailing?: string;
  /**
   * Draw the accent dot when there is no logo. On by default. It has no effect
   * once the integration has a mark — the logo always wins, because a card
   * that doesn't identify itself is the thing this replaced.
   */
  mark?: boolean;
  /** Override the integration's logo for this header. `data:` URI only. */
  icon?: string;
}

/**
 * The identity slot, left of the title: the integration's logo, or the accent
 * dot when it has none.
 *
 * The wrapper is a stable anchor on purpose — VoiceOS swaps its contents in
 * already-rendered documents (a confirmation card ships as static markup in
 * the manifest, long before the icon is drawn), so the swap has to be able to
 * find the slot and be safe to run twice.
 */
function markSlot(o: HeaderOptions): string {
  const src = safeImage(o.icon) || INTEGRATION_MARK;
  const inner = src
    ? `<img class="k-mk-i" src="${esc(src)}" alt="">`
    : o.mark === false
      ? ""
      : `<i class="k-dot"></i>`;
  // Always emitted, even empty: the swap above needs somewhere to land, and
  // `.k-mk:empty` collapses it so an unmarked card looks exactly as it did.
  return `<span class="k-mk" data-k-mk>${inner}</span>`;
}

/** The identity line: the integration's mark and a small uppercase label. */
export function vHeader(o: HeaderOptions): Block {
  const mark = markSlot(o);
  const trailing = o.trailing
    ? `<span class="k-hd-tr">${esc(clip(o.trailing, 28))}</span>`
    : "";
  const subtitle = o.subtitle
    ? `<div class="k-hd-sub">${esc(clip(o.subtitle, 64))}</div>`
    : "";
  return block(
    `<div class="k-hd"><div class="k-hd-l">${mark}<span class="k-hd-t">${esc(
      clip(o.title, 40),
    )}</span></div>${trailing}</div>${subtitle}`,
    o.subtitle ? 36 : 20,
  );
}

export interface RowItem {
  title: string;
  subtitle?: string;
  /** Right-aligned value. Pre-format it: "1.2k", "$40", "3:24". */
  trailing?: string;
  /** Small second line under the trailing value, e.g. a unit. */
  trailingSub?: string;
  /** A short status chip. */
  badge?: { text: string; tone?: Tone };
  /** data: URI only — the sandbox blocks every network request. */
  image?: string;
  /** https only. Makes the row open externally when clicked. */
  href?: string;
}

/**
 * The workhorse. Rows are plain objects rather than nested block calls
 * deliberately: an integration maps its API response straight through with
 * `.map()`, which is the shape a model gets right first time.
 */
export function vList(rows: RowItem[]): Block {
  if (!Array.isArray(rows) || rows.length === 0) {
    return vEmpty({ title: "Nothing to show" });
  }
  // Past five rows the card stops being a glance and starts being a list, and
  // six rows with subtitles overruns the 420px cap.
  const visible = rows.slice(0, 5);
  const overflow = rows.length - visible.length;

  const html = visible
    .map((row) => {
      const image = safeImage(row.image);
      const media = image
        ? `<img class="k-rw-img" src="${esc(image)}" alt="">`
        : "";
      const subtitle = row.subtitle
        ? `<div class="k-rw-sub">${esc(clip(row.subtitle, 72))}</div>`
        : "";
      const badge = row.badge
        ? `<span class="k-chip" style="color:${toneVar(row.badge.tone)}">${esc(
            clip(row.badge.text, 20),
          )}</span>`
        : "";
      const trailing =
        row.trailing || row.trailingSub
          ? `<div class="k-rw-tr"><span class="k-num">${esc(
              clip(row.trailing ?? "", 16),
            )}</span>${
              row.trailingSub
                ? `<span class="k-rw-trs">${esc(clip(row.trailingSub, 12))}</span>`
                : ""
            }</div>`
          : "";
      const href = safeUrl(row.href);
      const tag = href ? "a" : "div";
      const attrs = href ? ` href="${esc(href)}" data-k-link` : "";
      return `<${tag} class="k-rw"${attrs}>${media}<div class="k-rw-m"><div class="k-rw-t">${esc(
        clip(row.title, 80),
      )}</div>${subtitle}</div>${badge}${trailing}</${tag}>`;
    })
    .join("");

  const more =
    overflow > 0 ? `<div class="k-more">+${overflow} more</div>` : "";
  const rowHeight = visible.some((row) => row.subtitle || row.image) ? 46 : 32;
  return block(
    `<div class="k-list">${html}${more}</div>`,
    visible.length * rowHeight + (overflow > 0 ? 20 : 0),
  );
}

export interface StatItem {
  label: string;
  /** Pre-formatted. "48,210" not 48210.0; "$18.4k" not 18402.11. */
  value: string;
  /** A small delta beside the value, e.g. "+12.4%". */
  delta?: string;
  tone?: Tone;
}

/** One to three hero figures. The card's focal element when there is one. */
export function vStats(items: StatItem[], o: { rule?: boolean } = {}): Block {
  const visible = (items ?? []).slice(0, 3);
  if (visible.length === 0) return block("", 0);
  const html = visible
    .map(
      (item) =>
        `<div class="k-st"><div class="k-st-v" style="color:${toneVar(
          item.tone,
        )}">${esc(clip(item.value, 12))}${
          item.delta
            ? `<span class="k-st-d">${esc(clip(item.delta, 10))}</span>`
            : ""
        }</div><div class="k-st-l">${esc(clip(item.label, 20))}</div></div>`,
    )
    .join("");
  return block(
    `<div class="k-sts${o.rule ? " k-ruled" : ""}">${html}</div>`,
    46,
  );
}

export type Pair = { label: string; value: string; tone?: Tone };

/** Labelled detail lines — the fallback when a result is just facts. */
export function vKeyValue(pairs: Pair[]): Block {
  const visible = (pairs ?? []).slice(0, 5);
  if (visible.length === 0) return block("", 0);
  const html = visible
    .map(
      (pair) =>
        `<div class="k-kv"><span class="k-kv-l">${esc(
          clip(pair.label, 32),
        )}</span><span class="k-kv-v k-num" style="color:${toneVar(
          pair.tone,
        )}">${esc(clip(pair.value, 64))}</span></div>`,
    )
    .join("");
  return block(`<div class="k-kvs">${html}</div>`, visible.length * 22);
}

export interface BarsOptions {
  items: Array<{ label: string; value: number }>;
  /** Index of the bar to spend the accent on. Defaults to the largest. */
  highlight?: number;
  unit?: string;
}

/** A small column chart. One bar carries the accent; the rest are neutral. */
export function vBars(o: BarsOptions): Block {
  const items = (o.items ?? []).slice(0, 7);
  if (items.length === 0) return block("", 0);
  const max = Math.max(...items.map((item) => Number(item.value) || 0), 1);
  const peak =
    typeof o.highlight === "number"
      ? o.highlight
      : items.reduce(
          (best, item, i) => (item.value > items[best].value ? i : best),
          0,
        );
  const html = items
    .map((item, i) => {
      const pct = Math.max(
        2,
        Math.round(((Number(item.value) || 0) / max) * 100),
      );
      const value =
        i === peak
          ? `<span class="k-bar-v">${esc(clip(String(item.value), 8))}</span>`
          : "";
      return `<div class="k-bar"><div class="k-bar-c">${value}<div class="k-bar-f${
        i === peak ? " k-on" : ""
      }" style="height:${pct}%"></div></div><span class="k-bar-l">${esc(
        clip(item.label, 8),
      )}</span></div>`;
    })
    .join("");
  return block(
    `<div class="k-bars">${html}</div>${
      o.unit ? `<div class="k-cap">${esc(clip(o.unit, 24))}</div>` : ""
    }`,
    o.unit ? 88 : 72,
  );
}

export interface SparkOptions {
  points: number[];
  start?: string;
  end?: string;
  tone?: Tone;
}

/** A trend line. Inline SVG — no network, no library. */
export function vSpark(o: SparkOptions): Block {
  const points = (o.points ?? [])
    .filter((n) => typeof n === "number")
    .slice(0, 60);
  if (points.length < 2) return block("", 0);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points
    .map((point, i) => {
      const x = (i / (points.length - 1)) * 100;
      const y = 30 - ((point - min) / span) * 28;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const caption =
    o.start || o.end
      ? `<div class="k-spk-x"><span>${esc(clip(o.start ?? "", 16))}</span><span>${esc(
          clip(o.end ?? "", 16),
        )}</span></div>`
      : "";
  return block(
    `<svg class="k-spk" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="${toneVar(
      o.tone ?? "accent",
    )}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>${caption}`,
    caption ? 56 : 40,
  );
}

export interface MeterOptions {
  value: number;
  max?: number;
  label?: string;
  /** Right-aligned readout, e.g. "3:24 / 5:10". */
  trailing?: string;
  tone?: Tone;
}

/** A progress bar. */
export function vMeter(o: MeterOptions): Block {
  const max = Number(o.max) || 100;
  const pct = Math.max(0, Math.min(100, ((Number(o.value) || 0) / max) * 100));
  const head =
    o.label || o.trailing
      ? `<div class="k-mt-h"><span>${esc(clip(o.label ?? "", 40))}</span><span class="k-num">${esc(
          clip(o.trailing ?? "", 20),
        )}</span></div>`
      : "";
  return block(
    `${head}<div class="k-mt"><div class="k-mt-f" style="width:${pct.toFixed(
      1,
    )}%;background:${toneVar(o.tone ?? "accent")}"></div></div>`,
    head ? 28 : 11,
  );
}

/** Short status chips. */
export function vBadges(
  items: Array<string | { text: string; tone?: Tone }>,
): Block {
  const visible = (items ?? []).slice(0, 4);
  if (visible.length === 0) return block("", 0);
  const html = visible
    .map((item) => {
      const entry = typeof item === "string" ? { text: item } : item;
      return `<span class="k-chip k-chip-b" style="color:${toneVar(
        entry.tone,
      )}">${esc(clip(entry.text, 20))}</span>`;
    })
    .join("");
  return block(`<div class="k-bdg">${html}</div>`, 26);
}

export interface HeroOptions {
  /** data: URI only. */
  image?: string;
  eyebrow?: string;
  title: string;
  subtitle?: string;
}

/** A single object as the point of the card: artwork plus its identity. */
export function vHero(o: HeroOptions): Block {
  const safe = safeImage(o.image);
  const image = safe
    ? `<img class="k-hero-img" src="${esc(safe)}" alt="">`
    : "";
  const eyebrow = o.eyebrow
    ? `<div class="k-hero-e">${esc(clip(o.eyebrow, 24))}</div>`
    : "";
  const subtitle = o.subtitle
    ? `<div class="k-hero-s">${esc(clip(o.subtitle, 64))}</div>`
    : "";
  return block(
    `<div class="k-hero">${image}<div class="k-hero-m">${eyebrow}<div class="k-hero-t">${esc(
      clip(o.title, 60),
    )}</div>${subtitle}</div></div>`,
    56,
  );
}

/** A short line of prose. Use sparingly — a card is not a paragraph. */
export function vNote(text: string): Block {
  const value = clip(text, 200);
  if (!value) return block("", 0);
  // The one component that wraps, so the one that needs a real width model.
  // .k-note is 12.5px on a 358px content column ≈ 28.6em per line.
  const lines = Math.max(1, Math.ceil(textEms(value) / 28.6));
  return block(`<div class="k-note">${esc(value)}</div>`, lines * 17 + 4);
}

export function vDivider(): Block {
  return block(`<div class="k-div"></div>`, 9);
}

export function vEmpty(o: { title: string; hint?: string }): Block {
  return block(
    `<div class="k-empty"><div class="k-empty-t">${esc(
      clip(o.title, 48),
    )}</div>${o.hint ? `<div class="k-empty-h">${esc(clip(o.hint, 64))}</div>` : ""}</div>`,
    o.hint ? 52 : 34,
  );
}

export interface FieldOptions {
  /** The tool argument this edits — must be a key of the tool's inputSchema. */
  key: string;
  label: string;
  value?: string;
  multiline?: boolean;
}

/**
 * An editable tool argument, for confirmation cards.
 *
 * Typing posts `voiceos:updateInput`, and the staged value rides the user's
 * approval exactly like an edit to a declarative textField. The value is
 * hydrated from the init message's `args` at runtime, so the same markup works
 * for every invocation.
 */
export function vField(o: FieldOptions): Block {
  const key = esc(o.key);
  const control = o.multiline
    ? `<textarea class="k-in" rows="2" data-k-key="${key}">${esc(o.value ?? "")}</textarea>`
    : `<input class="k-in" type="text" data-k-key="${key}" value="${esc(o.value ?? "")}">`;
  return block(
    `<label class="k-fld"><span class="k-fld-l">${esc(
      clip(o.label, 32),
    )}</span>${control}</label>`,
    o.multiline ? 72 : 54,
  );
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/**
 * Tokens mirror voiceos-agent-ui/src/tokens.ts so a widget sits next to the
 * notch's own blocks without looking imported from another product.
 */
const CSS = `*{box-sizing:border-box;margin:0;padding:0;scrollbar-width:none}
/* No scrollbar chrome, EVER — on the document or on anything an author makes
   scrollable inside it. A card is glanced at on black glass; a scrollbar is
   desktop-browser furniture that instantly breaks that. This is the same
   rule the notch window applies to itself, mirrored here because the host's
   CSS cannot reach into the sandbox. Content stays scrollable (wheel,
   trackpad, drag) — only the bar is gone. */
::-webkit-scrollbar{display:none}
:root{--ink-1:rgba(255,255,255,.95);--ink-2:rgba(255,255,255,.72);--ink-3:rgba(255,255,255,.5);--ink-4:rgba(255,255,255,.42);--line:rgba(255,255,255,.08);--fill-1:rgba(255,255,255,.06);--fill-2:rgba(255,255,255,.1);--track:rgba(255,255,255,.12);--good:#30d158;--bad:#ff453a;--accent:#3987e5;--k-radius:26px;color-scheme:dark}
html[data-k-theme=light]{--ink-1:rgba(0,0,0,.92);--ink-2:rgba(0,0,0,.66);--ink-3:rgba(0,0,0,.46);--ink-4:rgba(0,0,0,.38);--line:rgba(0,0,0,.09);--fill-1:rgba(0,0,0,.04);--fill-2:rgba(0,0,0,.07);--track:rgba(0,0,0,.1);color-scheme:light;--accent:var(--accent-light,#2563c9)}
/* A body background PROPAGATES to the frame canvas — a transparent root does
   not stop that; per spec the canvas takes body's background when the root
   has none. So an author's \`body{background:#111}\` fills the whole frame,
   square and full-height, which is the right outcome: every host clips the
   frame at the card arc, so the fill meets the corner exactly. The one trap
   is repeat — the canvas tiles a gradient sized to a short body, so any
   gradient put on body must say no-repeat (the kit's accent wash does). */
body{font:13.5px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;color:var(--ink-1);background:transparent;border-radius:var(--k-radius);-webkit-font-smoothing:antialiased}
.k-wrap{padding:13px 15px 14px;display:flex;flex-direction:column;gap:10px;border-radius:var(--k-radius)}
.k-wrap.k-confirm{padding-bottom:52px}
.k-num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.k-hd{display:flex;align-items:center;justify-content:space-between;gap:10px}
.k-hd-l{display:flex;align-items:center;gap:7px;min-width:0}
.k-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:none}
.k-mk{display:flex;align-items:center;flex:none}
.k-mk:empty{display:none}
.k-mk-i{width:15px;height:15px;border-radius:4px;object-fit:contain;display:block}
.k-hd-t{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-hd-tr{font-size:11px;color:var(--ink-4);white-space:nowrap;flex:none}
.k-hd-sub{font-size:14.5px;font-weight:590;letter-spacing:-.01em;margin-top:-4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-list{display:flex;flex-direction:column}
.k-rw{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--line);text-decoration:none;color:inherit;min-width:0}
.k-rw:first-child{border-top:0;padding-top:1px}
a.k-rw{cursor:pointer}
a.k-rw:hover .k-rw-t{color:var(--accent)}
.k-rw-img{width:32px;height:32px;border-radius:6px;object-fit:cover;flex:none;background:var(--fill-1)}
.k-rw-m{min-width:0;flex:1}
.k-rw-t{font-size:14px;font-weight:590;letter-spacing:-.01em;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-rw-sub{font-size:11.5px;color:var(--ink-3);line-height:1.35;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-rw-tr{text-align:right;flex:none;display:flex;flex-direction:column;align-items:flex-end}
.k-rw-tr .k-num{font-size:12px;color:var(--ink-2)}
.k-rw-trs{font-size:10px;color:var(--ink-4);line-height:1.2}
.k-more{font-size:11px;color:var(--ink-4);padding-top:7px;border-top:1px solid var(--line)}
.k-chip{font-size:10.5px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:999px;background:var(--fill-1);white-space:nowrap;flex:none}
.k-bdg{display:flex;gap:6px;flex-wrap:wrap}
.k-sts{display:flex;gap:18px}
.k-sts.k-ruled{padding-top:9px;border-top:1px solid var(--line)}
.k-st{min-width:0}
.k-st-v{font-size:24px;font-weight:600;letter-spacing:-.02em;line-height:1.1;font-variant-numeric:tabular-nums;white-space:nowrap}
.k-st-d{font-size:11px;font-weight:500;color:var(--ink-3);margin-left:5px;letter-spacing:0}
.k-st-l{font-size:11px;color:var(--ink-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-kvs{display:flex;flex-direction:column;gap:0}
.k-kv{display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:3px 0}
.k-kv-l{font-size:12.5px;color:var(--ink-3);white-space:nowrap}
.k-kv-v{font-size:12.5px;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.k-bars{display:flex;align-items:flex-end;gap:6px;height:72px}
.k-bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0}
.k-bar-c{width:100%;height:56px;display:flex;align-items:flex-end;justify-content:center;position:relative}
.k-bar-f{width:100%;background:var(--fill-2);border-radius:4px 4px 2px 2px}
.k-bar-f.k-on{background:var(--accent)}
.k-bar-v{position:absolute;top:-2px;font-size:10px;font-weight:600;color:var(--ink-2);font-variant-numeric:tabular-nums}
.k-bar-l{font-size:10px;color:var(--ink-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.k-spk{width:100%;height:32px;display:block;overflow:visible}
.k-spk-x{display:flex;justify-content:space-between;font-size:10px;color:var(--ink-4);margin-top:4px;font-variant-numeric:tabular-nums}
.k-cap{font-size:10px;color:var(--ink-4);margin-top:4px}
.k-mt-h{display:flex;justify-content:space-between;gap:12px;font-size:11.5px;color:var(--ink-3);margin-bottom:6px}
.k-mt{height:5px;border-radius:5px;background:var(--track);overflow:hidden}
.k-mt-f{height:100%;border-radius:5px}
.k-hero{display:flex;align-items:center;gap:12px;min-width:0}
.k-hero-img{width:52px;height:52px;border-radius:8px;object-fit:cover;flex:none;background:var(--fill-1)}
.k-hero-m{min-width:0}
.k-hero-e{font-size:10px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-4)}
.k-hero-t{font-size:17px;font-weight:640;letter-spacing:-.02em;line-height:1.2;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-hero-s{font-size:12.5px;color:var(--ink-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-note{font-size:12.5px;line-height:1.4;color:var(--ink-2);overflow-wrap:anywhere;word-break:break-word}
.k-div{height:1px;background:var(--line);margin:4px 0}
.k-empty{text-align:center;padding:8px 0}
.k-empty-t{font-size:13px;color:var(--ink-3)}
.k-empty-h{font-size:11.5px;color:var(--ink-4);margin-top:3px}
.k-fld{display:block}
.k-fld-l{display:block;font-size:11px;color:var(--ink-3);margin-bottom:5px}
.k-in{width:100%;font:13px/1.4 inherit;color:var(--ink-1);background:var(--fill-1);border:1px solid var(--line);border-radius:7px;padding:7px 9px;outline:none;resize:none}
.k-in:focus{border-color:var(--accent)}
/* Custom-card shell (renderCustom): no padding, no gap, no layout opinion —
   the author owns the surface edge to edge. Only the confirm reserve, the
   floated mark, and the corner are the kit's.

   The corner is the kit's because it is not the author's to choose: the host
   cuts the card at --k-radius whatever this document says, so a surface drawn
   at any other radius shows a second edge inside the real one. Carrying it
   here means a card that paints a background or border on this element lands
   on the host's arc for free; a card that paints its own root still has
   var(--k-radius) to name. */
.k-cwrap{position:relative;border-radius:var(--k-radius)}
.k-cwrap.k-confirm{padding-bottom:52px}
.k-mkbar{position:absolute;top:11px;left:13px;z-index:9;display:flex}
/* ---- Surface finish (default-on) ----------------------------------------
   The liquid-glass rim: a 1px hairline with a brighter top edge, drawn as an
   INSET shadow on a fixed overlay so it (a) hugs the visible frame whatever
   height the content settles at, and (b) shares border-radius:var(--k-radius)
   with the host's clip — same arc, drawn inward, so it can neither gap nor
   get shaved by the cutout. This is the same rim recipe the notch's own
   chrome uses. */
.k-rim{position:fixed;inset:0;pointer-events:none;z-index:40;border-radius:var(--k-radius);box-shadow:inset 0 1px 0 rgba(255,255,255,.13),inset 0 0 0 1px rgba(255,255,255,.07)}
html[data-k-theme=light] .k-rim{box-shadow:inset 0 1px 0 rgba(255,255,255,.7),inset 0 0 0 1px rgba(0,0,0,.1)}
/* Brand presence (only when the integration declared an accent):
   a soft wash of the brand colour bleeding out of the top-left corner —
   colour the SURFACE, never the mark. The mark stays the bare glyph: a tile
   painted under the logo is chrome the icon didn't ask for, and it reads as
   the harness inventing a colour (see WIDGET_MARK_FLATTEN_HTML in ../ui.ts,
   which strips exactly that tile out of documents generated while the kit
   still drew one). color-mix degrades to no wash on engines without it. */
html[data-k-accent] body{background:radial-gradient(150% 120% at 0% 0%,color-mix(in srgb,var(--accent) 15%,transparent),transparent 44%) no-repeat}
html[data-k-theme=light][data-k-accent] body{background:radial-gradient(150% 120% at 0% 0%,color-mix(in srgb,var(--accent) 9%,transparent),transparent 44%) no-repeat}
/* The entrance is OPT-IN, never opt-out. Declaring \`animation: … both\` from
   opacity:0 and cancelling it under prefers-reduced-motion:reduce means any
   environment that doesn't actually run animations — a headless renderer, a
   paused compositor, a screenshotter — paints an invisible card and never
   recovers. Gating on no-preference makes the un-animated state the readable
   one, so the worst case is a card that simply appears. */
@media(prefers-reduced-motion:no-preference){
.k-wrap>*{animation:k-in .34s cubic-bezier(.22,.61,.36,1) both}
.k-wrap>*:nth-child(2){animation-delay:.04s}
.k-wrap>*:nth-child(3){animation-delay:.08s}
.k-wrap>*:nth-child(n+4){animation-delay:.12s}
}
@keyframes k-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}`;

/**
 * The runtime. Four jobs, all of them the reason a card author never has to
 * touch the bridge: apply the theme, hydrate `vField`s from the pending tool
 * arguments, report the real content height, and route link clicks out.
 *
 * The height report is why cards don't jump. `renderWidget` declares an
 * estimate from the block heights, and this corrects it against the measured
 * document as soon as layout settles — and again whenever it changes.
 */
const JS = `(function(){
var send=function(m){try{parent.postMessage(m,'*')}catch(e){}};
/* Result-widget actions. Only the parent can advertise access or return a result.
   Confirmation is owned by VoiceOS, outside this document. Never retry a send. */
var pendingTools=new Map();
var voiceos=window.voiceos=window.voiceos||{};
voiceos.canInvokeTools=false;
voiceos.invokeTool=function(name,args,options){
  var id=options&&options.requestId;
  if(!id){var bytes=new Uint32Array(4);crypto.getRandomValues(bytes);id=Array.from(bytes,function(n){return n.toString(16)}).join('_')}
  var failure=function(status,error){return {type:'voiceos:toolResult',requestId:id,status:status,error:error}};
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(id))return Promise.resolve(failure('failed','Invalid requestId.'));
  if(!voiceos.canInvokeTools)return Promise.resolve(failure('failed','Tool actions are unavailable in this card.'));
  var signature;try{signature=JSON.stringify([name,args])}catch(e){return Promise.resolve(failure('failed','Arguments must be JSON.'))}
  var prior=pendingTools.get(id);
  if(prior)return prior.signature===signature?prior.promise:Promise.resolve(failure('failed','This requestId already has different arguments.'));
  if(pendingTools.size>=64)return Promise.resolve(failure('failed','Too many pending actions.'));
  var resolve;var promise=new Promise(function(done){resolve=done});
  var timer=setTimeout(function(){pendingTools.delete(id);resolve(failure('unknown','No final response. Check the app before trying again.'))},135000);
  pendingTools.set(id,{resolve:resolve,promise:promise,timer:timer,signature:signature});
  send({type:'voiceos:invokeTool',name:name,args:args,requestId:id});
  return promise;
};
var last=0;
var report=function(){
  /* Never report a collapsed measurement. A frame that is display:none, zero
     width, or in a hidden tab measures ~0, and since the host CLAMPS to 60 and
     we'd then consider that our last known height, one bad sample pins a
     277px card at 60px forever. Staying silent leaves the declared estimate
     in place, which is close to right by construction. */
  if(document.hidden)return;
  var el=document.documentElement;
  if(!el.offsetWidth)return;
  var h=Math.ceil(el.getBoundingClientRect().height);
  if(h<8)return;
  if(Math.abs(h-last)>1){last=h;send({type:'voiceos:resize',height:h})}
};
/* data-voiceos-key is the alias custom markup uses; data-k-key is what the
   kit's own vField emits. Same contract either way. */
var argKey=function(el){
  if(!el||!el.getAttribute)return null;
  return el.getAttribute('data-k-key')||el.getAttribute('data-voiceos-key');
};
addEventListener('message',function(e){
  if(e.source!==parent)return;
  var m=e.data;if(!m)return;
  if(m.type==='voiceos:toolResult'){
    var pending=pendingTools.get(m.requestId);
    if(pending&&['completed','failed','cancelled','unknown'].indexOf(m.status)!==-1){clearTimeout(pending.timer);pendingTools.delete(m.requestId);pending.resolve(m)}
    return;
  }
  if(m.type!=='voiceos:init')return;
  voiceos.canInvokeTools=!!(m.capabilities&&m.capabilities.invokeTool);
  if(m.theme&&m.theme.mode)document.documentElement.setAttribute('data-k-theme',m.theme.mode);
  /* The corner the HOST will actually cut this card at. Same shape as the
     theme leg: the document ships with a correct default and the surface
     corrects it, so a card is never briefly drawn at the wrong radius and
     never depends on the host to send anything. Clamped because the value
     lands in CSS. */
  if(typeof m.radius==='number'&&isFinite(m.radius))document.documentElement.style.setProperty('--k-radius',Math.max(0,Math.min(48,m.radius))+'px');
  var args=m.args||{};
  var fields=document.querySelectorAll('[data-k-key],[data-voiceos-key]');
  for(var i=0;i<fields.length;i++){
    var key=argKey(fields[i]);
    if(Object.prototype.hasOwnProperty.call(args,key)&&args[key]!=null)fields[i].value=String(args[key]);
  }
  report();
});
document.addEventListener('input',function(e){
  var key=argKey(e.target);
  if(key)send({type:'voiceos:updateInput',key:key,value:e.target.value});
});
document.addEventListener('click',function(e){
  /* Routes BOTH the kit's data-k-link rows and plain <a href="https://…">
     anchors in custom markup out through the host. The sandbox blocks
     navigation anyway, so an unrouted anchor is a click that does nothing. */
  var el=e.target;
  while(el&&el!==document.body){
    if(el.getAttribute&&(el.hasAttribute('data-k-link')||(el.tagName==='A'&&el.hasAttribute('href')))){
      e.preventDefault();
      var href=el.getAttribute('href')||'';
      if(/^https:\\/\\//i.test(href))send({type:'voiceos:openUrl',url:href});
      return;
    }
    el=el.parentNode;
  }
});
if(window.ResizeObserver){new ResizeObserver(report).observe(document.documentElement)}
addEventListener('load',report);setTimeout(report,0);setTimeout(report,120);
})()`;

export interface RenderOptions {
  blocks: Blockish[];
  /** The integration's single brand colour. Used once per card. */
  accent?: string;
  /**
   * "confirm" reserves the bottom-right corner for the button VoiceOS floats
   * over the card. Always use it for a tool's confirmation view.
   */
  mode?: CardMode;
  /** Screen-reader label for the frame. */
  label?: string;
  /** Force a theme. Omit in production — `voiceos:init` decides. */
  theme?: ThemeMode;
}

export interface RenderedWidget {
  html: string;
  height: number;
  label?: string;
}

/** A brand colour is the one place an integration picks a hue, so it is
 * validated rather than trusted — a malformed value would break the whole
 * stylesheet, not just the dot. */
function safeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^#[0-9a-f]{3,8}$/i.test(trimmed) ||
    /^(rgb|hsl)a?\([0-9a-z%.,\s/]+\)$/i.test(trimmed)
    ? trimmed
    : null;
}

/** The notch's glass, and the light surface a card can also land on. */
const DARK_SURFACE: [number, number, number] = [10, 10, 12];
const LIGHT_SURFACE: [number, number, number] = [242, 242, 244];

/**
 * Strip content images from markup that blew the document cap. The
 * integration's own mark is never dropped — it is the card's identity and
 * costs a couple of hundred bytes.
 */
const dropImages = (markup: string): string =>
  markup.replace(/<img\b(?![^>]*\bk-mk-i\b)[^>]*>/g, "");

function hexToRgb(hex: string): [number, number, number] | null {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value.slice(0, 6);
  if (full.length !== 6 || /[^0-9a-f]/i.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: [number, number, number]): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

const contrast = (a: number, b: number): number =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const toHex = (rgb: [number, number, number]): string =>
  `#${rgb
    .map((c) =>
      Math.round(Math.max(0, Math.min(255, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/**
 * Repair a brand colour that can't be seen on the surface it lands on.
 *
 * An integration's accent is its real brand colour, and real brands include
 * near-black (#0b0b0d) and near-white (#ffd60a on light). Emitted unrepaired,
 * the first disappears into the notch's black glass and the second washes out
 * in light mode — in both cases the card's one spot of colour silently isn't
 * there. So each theme gets its own corrected value, nudged toward its
 * surface's opposite until it clears a 3:1 ratio, preserving the hue.
 */
function repairAccent(hex: string, against: [number, number, number]): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const target = luminance(against);
  const lighten = target < 0.5;
  let current: [number, number, number] = [...rgb] as [number, number, number];
  for (let step = 0; step < 24; step++) {
    if (contrast(luminance(current), target) >= 3) break;
    current = current.map((c) =>
      lighten ? c + (255 - c) * 0.12 : c * 0.88,
    ) as [number, number, number];
  }
  return toHex(current);
}

/**
 * The <html> attributes both renderers share: the forced theme (tests only)
 * and the per-surface corrected accent. Each surface gets its own repaired
 * value riding the same custom property, so no markup needs to know which
 * theme it is in.
 */
function rootAttributes(
  accent: string | null,
  theme: ThemeMode | undefined,
): string {
  const accentStyle = accent
    ? `--accent:${esc(repairAccent(accent, DARK_SURFACE))};--accent-light:${esc(
        repairAccent(accent, LIGHT_SURFACE),
      )}`
    : "";
  return [
    theme ? ` data-k-theme="${theme}"` : "",
    // Gates the brand treatment (the top-left wash): it derives everything
    // from --accent, so it only exists when the integration actually declared
    // one — the default blue is VoiceOS's, not a brand, and dressing it up
    // would make every unbranded card lie.
    accentStyle ? ` data-k-accent=""` : "",
    accentStyle ? ` style="${accentStyle}"` : "",
  ].join("");
}

/**
 * Compose blocks into the complete document a tool returns.
 *
 * The declared height is computed from the blocks rather than guessed, so the
 * card arrives at very nearly its final size; the runtime's measurement then
 * corrects the remainder. Both matter — a good estimate with no correction
 * drifts as content varies, and a correction with no estimate is a visible
 * jump on every single card.
 */
export function renderWidget(o: RenderOptions): RenderedWidget {
  const blocks = (o.blocks ?? []).filter(
    (candidate): candidate is Block =>
      Boolean(candidate) && typeof (candidate as Block).html === "string",
  );
  const accent = safeColor(o.accent);
  const confirm = o.mode === "confirm";

  // Every card identifies itself, including the ones that skipped vHeader.
  // Branding the card is the kit's job, not something each integration has to
  // remember, so a card with no mark anywhere gets a bare one prepended.
  const marked =
    INTEGRATION_MARK && !blocks.some((b) => b.html.includes("data-k-mk"))
      ? [
          block(`<div class="k-hd-l">${markSlot({ title: "" })}</div>`, 17),
          ...blocks,
        ]
      : blocks;

  const body = marked.map((b) => `<div>${b.html}</div>`).join("");
  const content = marked.reduce((sum, b) => sum + b.h, 0);
  const gaps = Math.max(0, marked.length - 1) * 10;
  const chrome =
    27 + (confirm ? WIDGET_KIT_LIMITS.confirmReserveHeight - 14 : 0);
  const height = Math.max(
    WIDGET_KIT_LIMITS.minHeight,
    Math.min(WIDGET_KIT_LIMITS.maxHeight, Math.round(content + gaps + chrome)),
  );

  const rootAttrs = rootAttributes(accent, o.theme);

  const compose = (inner: string): string =>
    `<!doctype html><html${rootAttrs}><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="k-wrap${
      confirm ? " k-confirm" : ""
    }">${inner}</div><div class="k-rim" aria-hidden="true"></div><script>${JS}</script></body></html>`;

  // Enforce the document cap HERE rather than trusting the caller. Over the
  // cap the host drops the card outright, so the integration appears to have
  // returned nothing at all — degrading is always better than vanishing.
  // Content images go first (already individually capped, but several still
  // add up), then whole blocks from the end, so the header and the lead
  // content are the last things to go.
  let kept = marked;
  let html = compose(body);
  if (html.length > WIDGET_KIT_LIMITS.maxHtmlChars) {
    html = compose(dropImages(body));
  }
  while (html.length > WIDGET_KIT_LIMITS.maxHtmlChars && kept.length > 1) {
    kept = kept.slice(0, -1);
    html = compose(
      dropImages(kept.map((b) => `<div>${b.html}</div>`).join("")),
    );
  }

  return { html, height, label: o.label };
}

// ---------------------------------------------------------------------------
// Custom cards
// ---------------------------------------------------------------------------

/**
 * The integration's logo slot, as a string for embedding inside custom markup
 * (see {@link renderCustom}). Put it where the card's own header puts its
 * identity — usually the top-left. VoiceOS swaps the logo in and keeps it
 * across icon redraws; until then it shows the accent dot.
 */
export function markHtml(): string {
  return markSlot({ title: "" });
}

export interface CustomRenderOptions {
  /**
   * The card's markup — everything that goes inside <body>. Authored freely:
   * any elements, inline SVG, its own <script> when behaviour beyond the
   * bridge is needed. Interpolate every API string through {@link esc}.
   */
  body: string;
  /**
   * The card's stylesheet, appended after the kit's base. The base contributes
   * the colour variables (--ink-1..4, --line, --fill-1/2, --track, --accent,
   * --good, --bad), the system font on <body>, and nothing else that
   * constrains layout — the author owns the surface edge to edge.
   */
  css?: string;
  /** The integration's single brand colour — lands on --accent, both themes. */
  accent?: string;
  /**
   * "confirm" reserves the bottom-right corner for the button VoiceOS floats
   * over the card. Always use it for a tool's confirmation view.
   */
  mode?: CardMode;
  /** Screen-reader label for the frame. */
  label?: string;
  /**
   * Declared height estimate in px (clamped 60-420). The runtime corrects it
   * against the measured document, but a close estimate is what stops the
   * card visibly resizing as it arrives.
   */
  height?: number;
  /** Force a theme. Omit in production — `voiceos:init` decides. */
  theme?: ThemeMode;
}

/**
 * Compose hand-authored markup and CSS into the complete document a tool
 * returns — the full-fidelity sibling of {@link renderWidget}.
 *
 * Where `renderWidget` owns the whole visual layer, this owns only what a
 * bespoke card cannot be trusted to carry itself:
 *  - the bridge (theme, height report, arg hydration via `data-voiceos-key`,
 *    link routing for plain https anchors),
 *  - the integration's mark — embedded wherever the body placed
 *    {@link markHtml}, or floated over the top-left when it didn't, so a
 *    custom card can never go out unsigned,
 *  - the colour variables and per-theme accent repair,
 *  - the document character cap (content images are dropped first; a card still
 *    over the cap throws, because the host would drop it silently).
 */
export function renderCustom(o: CustomRenderOptions): RenderedWidget {
  const body = typeof o.body === "string" ? o.body : "";
  const confirm = o.mode === "confirm";
  const rootAttrs = rootAttributes(safeColor(o.accent), o.theme);

  // A stylesheet can't be HTML-escaped without breaking it; neutralising the
  // one sequence that could terminate the tag keeps the document intact.
  const authorCss =
    typeof o.css === "string" ? o.css.replace(/<\/style/gi, "<\\/style") : "";

  // Emitted even when there is no mark yet: confirmation cards are frozen
  // into the manifest before the icon is drawn, and the swap that adds the
  // logo later needs an anchor to land on. `mark: false` keeps the empty slot
  // invisible rather than floating a placeholder dot over bespoke UI.
  const markBar = body.includes("data-k-mk")
    ? ""
    : `<div class="k-mkbar">${markSlot({ title: "", mark: false })}</div>`;

  // The rim rides OUTSIDE the author's wrap, after author CSS, precisely so a
  // bespoke card cannot lose it by styling its own tree — the surface finish
  // is the host's look, not the card's to opt out of.
  const compose = (inner: string): string =>
    `<!doctype html><html${rootAttrs}><head><meta charset="utf-8"><style>${CSS}\n${authorCss}</style></head><body><div class="k-cwrap${
      confirm ? " k-confirm" : ""
    }">${markBar}${inner}</div><div class="k-rim" aria-hidden="true"></div><script>${JS}</script></body></html>`;

  let html = compose(body);
  if (html.length > WIDGET_KIT_LIMITS.maxHtmlChars) {
    html = compose(dropImages(body));
  }
  const chars = html.length;
  if (chars > WIDGET_KIT_LIMITS.maxHtmlChars) {
    throw new Error(
      `Widget HTML is ${chars} characters, over the ${WIDGET_KIT_LIMITS.maxHtmlChars} limit — trim the markup, show less, or inline smaller images.`,
    );
  }

  const height = Math.max(
    WIDGET_KIT_LIMITS.minHeight,
    Math.min(
      WIDGET_KIT_LIMITS.maxHeight,
      Math.round(Number(o.height) || WIDGET_KIT_LIMITS.defaultHeight),
    ),
  );
  return { html, height, label: o.label };
}

/**
 * Fail loudly at build time rather than quietly at render time. The host drops
 * an over-cap card entirely, which looks like the integration returned
 * nothing — a thrown error during a test drive is far easier to act on.
 */
export function assertWithinLimits(card: RenderedWidget): RenderedWidget {
  const chars = card.html.length;
  if (chars > WIDGET_KIT_LIMITS.maxHtmlChars) {
    throw new Error(
      `Widget HTML is ${chars} characters, over the ${WIDGET_KIT_LIMITS.maxHtmlChars} limit — show fewer rows or smaller images.`,
    );
  }
  return card;
}
