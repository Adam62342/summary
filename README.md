# Dia Tab Hover

A Dia-style hover card for Zen's sidebar tabs.

Hover a tab for about half a second and a small card appears just off the tab's edge, slightly below it. It shows the tab's title and domain, and four quick actions:

- **Back**: take that tab back one page. It's dimmed when there's nothing to go back to.
- **Bookmark**: add the page to Other Bookmarks, or remove the bookmark. It fills in when the page is bookmarked.
- **Split view**: open the tab side by side with your current tab, using Zen's split view.
- **Copy link**: copy the tab's URL.

Once the card is showing, moving to another tab switches it right away. You can move the mouse onto the card to use the buttons. Clicking anywhere else, scrolling, or leaving the window hides it.

Firefox's own tab tooltip and thumbnail preview are suppressed while the mod is on. You can turn that off in the mod's settings.

The card follows your system's light or dark appearance.

## Install

1. Copy the `dia-tab-hover` folder into your profile at `chrome/sine-mods/dia-tab-hover`.
2. Clear the startup cache in `about:support`, then restart Zen.
