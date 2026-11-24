# YCH Price Tiers

Userscripts that show the real prices of YCHs (your character here), commissions and auctions right under each thumbnail, so you don't have to open every listing to find out what it costs. Plus a small extra for sharing Fur Affinity art on Discord.

| Site | Script | Install |
|---|---|---|
| [Fur Affinity](https://www.furaffinity.net/) | Fur Affinity Price Tiers | [**Install**](https://raw.githubusercontent.com/Megoman16/YCH-Price-Tiers/main/fa-price-tiers.user.js) |
| [ych.commishes.com](https://ych.commishes.com/) | YCH.Commishes Price Sorter + Tier Chips | [**Install**](https://raw.githubusercontent.com/Megoman16/YCH-Price-Tiers/main/ych-commishes.user.js) |
| [ych.art](https://ych.art/) | YCH.art Price Tiers | [**Install**](https://raw.githubusercontent.com/Megoman16/YCH-Price-Tiers/main/ych-art.user.js) |
| [Fur Affinity](https://www.furaffinity.net/) | FurAffinity → Discord Link Copier | [**Install**](https://raw.githubusercontent.com/Megoman16/YCH-Price-Tiers/main/fa-discord-links.user.js) |

## How to install

1. Install a userscript manager in your browser: [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari, Opera) or [Violentmonkey](https://violentmonkey.github.io/).
2. Click an **Install** link above. Your userscript manager opens and shows an **Install** button. Click it.
3. Open the site. The chips show up under the thumbnails, and the script's buttons appear next to the site's sort menu (or in a bar above the gallery on Fur Affinity).

The scripts update themselves. Your userscript manager checks this page for new versions (Tampermonkey: about once a day, or right away with **Utilities → Check for userscript updates**).

## What you get

- **Price chips** read from each listing's description: tiers ("Sketch $20", "Full render $60"), add-ons in grey ("+$10 extra character"), starting bid / buyout (SB / AB) and bid goals, grouped under the description's own headings.
- **True cost**: the most expensive tier, or the current bid if that's higher. Add-ons don't count, and neither does an AB / buy-now price with nothing after it saying what you get.
- **Hover** over the chips to see every price line in full.
- **Sort** by price or by true cost, from the site's sort menu (ych.commishes, ych.art) or the toolbar (Fur Affinity).
- **Saved prices**: listings you've seen load instantly next time.

Fur Affinity only:

- **Follows links** when the prices are somewhere else: another FA submission or journal, a carrd or other website, a public Google Doc, or a ych.commishes / ych.art auction (with its current bid, time left, and whether it's ended).
- **Raffles / giveaways**: shows the draw date and the X / Bluesky post's likes, reposts, replies and views.
- **Toolbar**: sort by true cost, load the next *N* pages, count how many pages there are, hide listings with no price, hide ended auctions and raffles, retry failed reads, clear the saved prices.
- Reads a few submissions at a time and backs off on its own if Fur Affinity asks it to slow down.

## FurAffinity → Discord Link Copier

Adds two buttons under the title of every Fur Affinity submission page (`/view/` and `/full/`):

| Button | What gets copied | How it looks in Discord |
|---|---|---|
| **Discord: link** | `[Title by Artist](<https://www.furaffinity.net/view/123/>)` | Clickable "Title by Artist" text, no preview box |
| **Discord: link + image** | The link above, plus the direct `d.furaffinity.net` image URL on the next line | Clickable title with the full image embedded under it |

- Mature and Adult submissions get their image wrapped in `||spoiler||` automatically. **Shift-click** the button to flip that.
- Paste into any Discord message. Post Mature/Adult art only in age-restricted channels.
- It only reads the page you're on. It doesn't need access to any other site.

## Permissions (Fur Affinity Price Tiers script)

To read price lists, auctions and raffle posts on other sites, the Fur Affinity script asks your userscript manager for access to other websites. The first time it reads a new site (for example `ych.commishes.com`, `api.fxtwitter.com` for X posts, or someone's carrd page), Tampermonkey asks you to allow it. Choose **Always allow** (or **Always allow all domains**) so it doesn't keep asking.

It only reads pages linked from the submissions you're browsing, and it never posts or changes anything.

## Problems?

Prices are written in a lot of different ways, so some listings won't be read right. [Open an issue](https://github.com/Megoman16/YCH-Price-Tiers/issues) with a link to the listing (or its description text) and what it should have shown.

For the Discord copier, include the submission link and what got copied.
