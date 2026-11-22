# Instagram Saved Review

Review your Instagram saved posts one at a time and decide what to do with each: **Keep**, **Unsave**, or **Review later**. Everything runs locally in your browser. There is no server, no account, and no tracking.

> **Unofficial project.** This extension is not affiliated with, endorsed by, or sponsored by Instagram or Meta. See [Limitations and disclaimer](#limitations-and-disclaimer).

## Features

- **One-by-one review** of your saved posts, reels and IGTV links, right on Instagram.
- **Three decisions:** Keep, Unsave (uses Instagram's own bookmark button and verifies it changed), or Review later (moves the item to the end of the queue).
- **Keyboard shortcuts** for fast triage.
- **Undo** for your last five unsaves (`Ctrl+Z`).
- **Two modes:** a single reusable tab, or a five-tab queue that preloads upcoming items.
- **Automatic skipping of removed posts**, including posts where Instagram redirects the tab to the creator's profile instead of showing an error. The review keeps going instead of stopping.
- **Pause and resume**, with progress saved as you go.
- **Start from beginning** to re-review everything that is still saved.
- **Draggable review bar** that remembers where you put it.
- **Private by design:** your export file never leaves your computer.

## Requirements

- Google Chrome (or another Chromium-based browser that supports Manifest V3 extensions). A recent version is expected to work; Chrome 109 or later is the target.
- An Instagram account that is logged in in the same browser.
- Your Instagram data export containing `saved_posts.json` (see below).

## Get your `saved_posts.json`

1. On Instagram, request a copy of your data (usually under **Accounts Center → Your information and permissions → Download your information**).
2. Choose **JSON** as the format and include your **saved** items.
3. When Instagram emails you the download, unzip it and find `saved_posts.json`. It is usually in a folder named something like `your_instagram_activity/saved`.

Instagram changes its menus from time to time, so the exact names may differ. Sign in to the Instagram account that produced the export before you start reviewing.

## Install (load unpacked)

The extension is not on the Chrome Web Store yet, so you install it manually in developer mode.

1. **Get the code.**
   - Clone it: `git clone https://github.com/<your-username>/<repo-name>.git`
   - Or download the repository as a ZIP from GitHub (**Code → Download ZIP**) and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. *(Optional)* Click the puzzle-piece icon in Chrome's toolbar and **pin** Instagram Saved Review for quick access.

### Updating

When you pull or download a newer version:

1. Replace or update the folder contents.
2. Go to `chrome://extensions` and click the **reload** icon on the extension.
3. **Refresh any open Instagram tabs.** Old tabs keep running the previous version of the content script until you do.

## How to use

1. Make sure you are logged in to Instagram in this browser.
2. Click the extension icon to open the popup.
3. Drop your `saved_posts.json` onto the dashed area, or click it to browse. You will see how many unique saved items were loaded.
4. Choose a review mode:
   - **One tab:** reuses a single review tab.
   - **Five-tab queue:** keeps the next items loading in background tabs.
5. Click **Start review**. The first saved item opens on Instagram with the review bar floating over it.
6. Decide on each item with the review bar or the keyboard. Each decision advances to the next item.
7. Click **Pause review** in the popup to stop and resume later. Your decisions and review-later list are saved as you go. If you close Chrome, start a new review to continue from the remaining items in the same order.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `K` | Keep |
| `D` | Unsave |
| `J` | Review later |
| `M` | Mute / unmute the current video |
| `Ctrl+Z` | Undo the most recent unsave |

Shortcuts are ignored while you are typing in a text field. You can also drag the review bar by its grip, or focus the grip and use the arrow keys.

### What each decision does

- **Keep** records the decision and moves on. Nothing changes on Instagram.
- **Unsave** clicks Instagram's visible bookmark, checks that it now shows the unsaved state, and then advances. If the extension cannot find or verify the bookmark, it stays on the item so you can unsave it yourself or choose Review later.
- **Review later** makes no decision. The item moves to the end of the queue, after all other new items. If it is the last item left, Review later is refused and you must Keep or Unsave.

### Undo

Click **Undo** or press `Ctrl+Z` to re-save the most recently unsaved post in the current review tab. Then choose Keep, Unsave, or Review later to continue. Posts and reels share one history of the last five unsaves. A failed restore stays in the history so you can retry.

### Checking a creator's profile

Open the profile from the item as usual. Use Chrome's **Back** button or **Return to review** in the popup to resume at the same item. Your waiting tabs stay in the queue.

### Start from beginning

Reviews every item that is still saved, in export order, including kept items and items marked Review later. Previously unsaved and unavailable items are excluded. Your stored decisions are not changed by deferring inside this pass.

## Removed or unavailable posts

Deleted or removed posts are skipped automatically and recorded as **unavailable**. The extension does not click or unsave anything for these.

- Instagram often redirects a removed post to the creator's profile and shows "this page isn't available". The extension recognizes that redirect while it is opening a queued item, so the review does **not** end early.
- A skip note appears on the next available item, for a few seconds. Several skips are combined into one count.
- If **10 items in a row** look unavailable, the review pauses automatically. This protects you if you are logged out or Instagram is limiting your account. Check Instagram, then resume.
- While paused, **Recheck unavailable items** makes them pending again.

Detection looks for no bookmark control, no visible media, and either the English error text "this page isn't available" or a 404 response, confirmed again about 1.2 seconds later.

## Privacy and permissions

- Your export and all review progress are stored locally with `chrome.storage`. Nothing is sent anywhere.
- The extension requests only:
  - `storage`, to save your progress and settings.
  - Access to `https://www.instagram.com/*`, to show the review bar and operate Instagram's bookmark button.
- It makes no network requests of its own and loads no remote code.

## Limitations and disclaimer

- **English only for now.** Unsave recognizes English bookmark labels, and unavailable-post detection uses an English phrase. Other languages may not work.
- **Depends on Instagram's page structure.** Instagram can change its interface at any time and break bookmark detection. When that happens the extension stops safely and leaves you on the item, but it may need an update.
- **Automates clicks on Instagram's own controls** in response to your actions. This may be against Instagram's terms of use, and Instagram could rate-limit or restrict accounts for unusual activity. Use at your own risk, review at a human pace, and stop if Instagram shows warnings.
- Chromium-based browsers only.
- Chrome and Instagram control when videos load and play.

## Troubleshooting

| Problem | What to try |
|---|---|
| The review bar does not appear | Reload the extension at `chrome://extensions`, then refresh the Instagram tab. Make sure you are on `www.instagram.com` and logged in. |
| "Couldn't verify the bookmark changed" | Check the item on Instagram. Unsave it manually or choose Review later, then continue. |
| Review paused after unavailable items | Check you are logged in and Instagram loads normally, then resume. Use **Recheck unavailable items** if needed. |
| Import says the file is invalid | Make sure you chose `saved_posts.json` from a JSON-format export, not the HTML export. |
| Nothing happens after an update | Reload the extension and refresh all Instagram tabs. |

## Project structure

```
manifest.json   Extension manifest (Manifest V3)
background.js   Service worker: queue, decisions, undo, tab handling
content.js      Review bar and unavailable-post detection (shadow DOM)
popup.html      Popup markup and styles
popup.mjs       Popup logic
export.mjs      saved_posts.json parser
```

## Roadmap

These are planned improvements. They are ideas, not promises, and have no dates.

**UI**
- A refreshed popup and review bar based on a shared design-token system (colors, spacing, radii) for a more consistent look. *In progress.*
- Clearer error and warning styling in the review bar.
- A compact review bar for narrow windows.
- A completion screen with final tallies, and a "review in progress" indicator in the popup.

**Code quality and reliability**
- Break up the largest functions in `background.js` and `content.js` into smaller, named parts.
- Add automated unit tests, especially for the queue, undo, and unavailable-post redirect logic.
- Faster storage for large saved lists (thousands of items).
- Fewer background wake-ups by filtering browser tab events to Instagram only.
- Broader support for different Instagram export file formats.

**Project and releases**
- GitHub Actions for automated checks (syntax, tests, manifest validation) on every pull request.
- Branch protection and pull-request based changes.
- Tagged releases with a packaged ZIP.
- Extension icons and a possible Chrome Web Store listing.
- Support for languages other than English.

Have an idea? Open an issue.

## Contributing

Issues and pull requests are welcome. Please keep changes focused, describe what you changed and why, and test a full review (including a removed post that redirects to a creator's profile) before submitting. Do not modify the unavailable-post detection logic without discussing it first, since it handles tricky Instagram behavior.
