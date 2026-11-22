function mediaPermalink(value) {
  try {
    const url = new URL(value);
    if (!["www.instagram.com", "instagram.com"].includes(url.hostname)) return null;
    if (url.protocol !== "https:") return null;
    const match = /^\/(p|reels?|tv)\/([\w-]+)\/?$/.exec(url.pathname);
    if (!match) return null;
    const [, type, id] = match;
    return { id, type: type === "reels" ? "reel" : type };
  } catch {
    return null;
  }
}

export const mediaId = value => mediaPermalink(value)?.id ?? null;

export function parseExport(data) {
  const rows = Array.isArray(data) ? data : data?.saved_saved_media;
  if (!Array.isArray(rows)) throw new Error("Choose an Instagram saved_posts.json export.");
  const entries = new Map();
  for (const row of rows) {
    const field = row?.label_values?.find?.(item => item?.label === "URL");
    const item = mediaPermalink(field?.href) ?? mediaPermalink(field?.value) ??
      mediaPermalink(row?.string_list_data?.[0]?.href);
    if (item && !entries.has(item.id)) entries.set(item.id, item.type);
  }
  if (!entries.size) throw new Error("No Instagram saved media links were found in this export.");
  return { ids: [...entries.keys()], types: Object.fromEntries(entries), excluded: rows.length - entries.size };
}
