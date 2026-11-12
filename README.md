# achat

Designing your own chat look? Start with CUSTOM-CSS-GUIDE.md in this folder.

The full, illustrated guide is built in: with the app running, open http://127.0.0.1:7788/guide in any browser, or choose "Open the guide" from the menu in the dock. This file is the short version.

An interactive chat overlay for OBS that reads YouTube, Twitch and TikTok chat at the same time. Viewers can pop GIFs on screen and challenge each other to battles, and you control everything from a panel docked inside OBS.

## What you need

Windows 10 or 11, OBS Studio (update to the newest version, see the security note below), and Node.js 20 or newer from https://nodejs.org (the LTS installer is fine).

## First start

1. Unzip this folder somewhere permanent, for example `Documents\achat`.
2. Double-click `start.bat`. The first run installs its packages, which takes a minute.
3. The window prints two links. achat now runs in the background, so you can close that window; it keeps running.

That's the only thing you ever need to do: double-click `start.bat`. It installs missing packages by itself, and if achat is already running it closes that one and starts the latest. To stop achat, press **Stop achat** in the dock's Settings tab, or double-click `stop.bat`. What achat prints goes to `data/achat-log.txt`.

## Add it to OBS

**The overlay.** In your scene, add a Browser Source. Paste `http://127.0.0.1:7788/overlay?layer=all`, set width 1920 and height 1080, and tick "Refresh browser when scene becomes active". If you want to place chat, GIFs and battles separately, use `layer=chat`, `layer=gif` and `layer=battle` as three sources instead. The Connect tab in the dock has copy buttons for all four.

**The control panel.** In OBS go to Docks, then Custom Browser Docks. Name it `achat` and paste the dock link from the app window (the one with `token=` in it). Treat that link like a password and keep it off stream.

## Connect your channels

Open the Connect tab in the dock and switch on each platform.

YouTube takes your `@handle`, channel ID, or a video link. If you have a scheduled stream, achat reads its chat right away (the waiting-room chat) and keeps going when the stream starts. With nothing scheduled or live, it checks every 30 seconds, so you can switch it on before starting the stream. Twitch takes your channel name. TikTok takes your username. TikTok connections go through a free signing service (Euler Stream) that is rate limited, so if TikTok keeps waiting, get a key from eulerstream.com and paste it in the sign key field.

**YouTube through the official API (optional).** Under YouTube in the Connect tab, open "Official YouTube Data API" if you'd rather read chat through Google's supported API. Create an API key at console.cloud.google.com with "YouTube Data API v3" enabled, paste it, and tick "Read YouTube chat with the official API". achat still finds your stream the usual way (that costs no quota), then reads chat with `liveChatMessages.list` (5 quota units per check) and the viewer count with `videos.list` (1 unit a minute). A free key has 10,000 units a day, so the default of one check every 8 seconds lasts about 4.5 hours of streaming a day; set a longer interval for longer streams. If the key is wrong or the daily quota runs out, achat switches back to the default method by itself and says so in the Log. The official API sends standard emoji as text and no custom-emote images.

## Viewer commands

`!gif happy cat` shows a GIF found on GIPHY. `!battle @name` challenges someone who chatted in the last 15 minutes, on any platform, and `!battle` alone lets anyone `!join`. The challenged viewer answers `!accept` or `!decline`. Your mods and you can type `!skipgif` and `!cancelbattle`.

## GIF setup

In the GIFs tab, pick a search provider and paste its key.

**KLIPY (recommended).** Sign up at partner.klipy.com and create a key on the API Keys page. A new key is a free test key limited to 100 searches an hour. For unlimited searches, open the three-dot menu on the key and choose "Request Production"; KLIPY reviews the request, and production keys are free with no request limit. Once approved, set "Searches per hour limit" to 0. KLIPY can mix optional ads into results for apps that want to earn from them; leave that off in the dashboard. achat also drops any ad slot it receives, so an ad can never reach your stream.

**GIPHY.** A free key from developers.giphy.com allows 100 searches an hour. GIPHY's unlimited keys are paid.

Either way, repeat searches are cached for an hour and don't count toward the limit, and a small provider credit shows on each GIF as both providers require.

GIFs are filtered in several layers: the G rating, your blocked word list (applied to what viewers type and to each result's title), and cooldowns. No filter is perfect, so keep an eye on it and use Remove last GIF in the dock or `!skipgif` in chat if something slips through.

## Troubleshooting

**YouTube says "Not live yet" while the channel is live.** First make sure the channel is live on YouTube itself, since many streamers are live only on Twitch. Press "Check now" to skip the 30 second wait. The Log tab shows what each check found. If it still won't connect, press "Save debug files" and send the files from the `data/debug` folder; they contain exactly what YouTube sent back. Pasting the stream's video link into the YouTube field skips detection entirely. Members-only streams need a logged-in member and can't be read.

**Test GIF does nothing.** The GIFs tab shows the result of the last attempt under the buttons, and a yellow warning appears if none of your OBS sources can show GIFs in the current Display mode. The most common cause is a "Chat only" source with Display set to "Separate spot".

## Chat animation

In the Look tab, "New messages come in from" picks Below, Left or Right. "How new messages arrive" also has three animated choices that keep your template's look: **Curve** (chat bends into an arc and messages glide along it), **Accordion** (older messages fold up in 3D) and **Liquid** (messages drip in and melt together like goo). With these three, Speed still works; Custom CSS mode uses the normal animation. Messages always enter strictly one by one: each one fully lands before the next starts. Animation speed sets how long each entry takes, and "Pause after each message lands" sets the breather before the next one. When chat is flooded, entries get shorter instead of overlapping, so the overlay never falls behind. "Test 5 at once" previews it.

If animations still stutter in OBS, check two OBS settings. In Settings, Advanced, make sure "Enable Browser Source Hardware Acceleration" is on (restart OBS after changing it). In the Browser Source properties, tick "Use custom frame rate" and set it to 60.

## Chat templates

Style has seven templates: Default (colors editable), Dark, **Cloud Puff** (a simple white bubble with the cloud buddy from the achat logo peeking over the corner), and four window templates. Each is a little app window with a striped title bar, window dots, a speech tail and a mascot peeking over the corner: **Kitty Window** (pink, black cat), **Bunny Note** (lavender, white bunny), **Matcha Leaf** (green, frog) and **Starlight** (midnight blue, sleepy star). They give hosts, mods, VIPs and members (subs on Twitch) their own tag, and Super Chats turn the window gold. Light, Sakura, Midnight Gold, Glass, Kawaii and Pastel Bow were removed, and so were the three EAAK styles (Star Cat, Goat, Crimson Cat) for chat and clock; if you used one, achat switches chat to Default and the clock to Match chat template.

## Placing things on stream

Every part can be moved right where you set it up: the Style tab has a "Position on stream" box for chat, the GIFs and Polls tabs place their boxes (used when they're set to "Layout box"), and the Clock tab places the clock. Each one moves only its own box; the other boxes show faded so you can see where everything is. The Layout tab still shows all of them together, and a change in one place shows up everywhere.

## Clock

Turn on the clock in the dock's **Clock** tab to show your PC's time on stream. Move and resize the green Clock box right there in the Clock tab (or in Layout, where you see it next to everything else); the clock grows or shrinks to fill it. The **Clock look** menu has **Match chat template** (follows Style), any template just for the clock (Default, Dark, Kitty Window, Bunny Note, Matcha Leaf, Starlight), so chat and clock can look different, and simple text: **Plain** (big white time with the date under it) or **Outline** (white with a dark outline, readable on bright scenes). You can hide the seconds or the date, switch to 12-hour time, and pick the date format: long (Tuesday, 29 September 2026), short (Tue 29 Sep) or numbers (29/09/2026). There's also a "Clock only" link in Connect if you'd rather place it as its own OBS source.

## Live tab

The dock opens on the new **Live** tab once a platform is connected. The top shows your viewers: the total, then YouTube, Twitch and TikTok. TikTok's count comes live from TikTok, YouTube's is checked every 30 seconds, and Twitch's once a minute through decapi.me. Below it is one chat from all three platforms, with All / YT / TW / TT filters and a search box. Point at a message to **Hide** it from the stream, **Block** that viewer from commands, or **Feature** it: it's pinned at the top of chat on stream, for as long as you set under the chat (20 seconds by default, 0 keeps it up until you take it off). Under that, choose where it appears: pinned at the top of chat, or in its own Featured box that you move and resize right there in the Live tab (or in Layout). Super Chats, mods, members and messages that mention your channel get a colored edge.

## New in version 2.0.1

Layout boxes can now be resized from any corner or side, not just the bottom-right corner. With Custom CSS on the Everything link, chat is drawn inside the Chat box, so moving and resizing that box works (the Chat only link still fills its whole source). Custom CSS mode no longer shows platform logos.

## New in version 2.0.0

bae+Chat is now **achat**, with a new logo. With Custom CSS on, the edge fade can be set again (Style, right under the CSS editor); new messages still rest above the bottom fade even if your CSS sets its own padding. Your settings, presets and custom GIFs carry over: keep your `data` folder. Custom CSS class names (like `.bae-platform-logo` and `.bae-gif`) are unchanged, so existing CSS keeps working.

## New in version 1.9.2

The Connect tab now shows, for every overlay link, whether it's really open somewhere ("Open in 1 place" or "Not open anywhere"), so you can see at once if an OBS source isn't loading. Copy now works inside OBS's dock (OBS can block the normal clipboard), each link sits in a box where one click selects exactly the link, and a new Open button loads the link in your browser with its status panel.

If a link says "Not open anywhere" although you added it in OBS: open that source's Properties, clear the URL field, paste the link again using Copy, and make sure the source is visible and "Shutdown source when not visible" is off.

## New in version 1.9.1

The Test button now tells you in plain words what happened after every test, and when something can't be seen it says why and what to change (for example: no overlay open in OBS, GIFs switched off, or the GIF went to a Layout box your OBS source doesn't show). "Chat message" is the default test. If the panel has lost its connection to the app, pressing Run says so. The panel also warns when it's an older version than the app and needs reopening in OBS.

## New in version 1.9.0

Custom CSS is now its own world: chat fills the whole Browser Source exactly like YouTube's chat popout, and every template setting (size, colors, position, animation, fades) is switched off, so the Style tab shows only the CSS editor. New to CSS? Read CUSTOM-CSS-GUIDE.md in this folder, or press "Start from the starter" in the editor for a working example with notes (also in this folder as custom-css-starter.css). "Hide !commands", the bot list and the control panel look moved to the new Settings tab (formerly Moderation).

## New in version 1.8.4

Fixed: with Custom CSS, messages could overlap and look blown up when the CSS gave messages a percentage height (common in YouTube chat themes). The message list now sizes itself like YouTube's own chat list. Custom CSS mode no longer adds the overlay's entry animation; messages appear instantly and your CSS's own animations play.

## New in version 1.8.3

Fast chat keeps up: when messages pile up, everything waiting comes in together in one quick motion, so the overlay stays within about a second of live chat and no message is dropped (before, a 40-message flood showed only 11 and lagged up to 7 seconds). New "Chat size" slider in Style scales the whole chat for every look, including Custom CSS. The layout editor's grid control is now labeled "Snap grid" (it sets drag spacing, it isn't a zoom). New "Spam" test.

## New in version 1.8.2

Fixed: a large bottom (or top) edge fade could hide the newest messages or the whole chat; new messages now rest just above the bottom fade, and each fade is capped at 35% of the chat box. Fixed: one message failing to draw could freeze chat for the rest of the stream. New: open the overlay link in a normal browser to see a status panel (connection, messages received, chat box, fades, errors). OBS never shows it.

## New in version 1.8.1

Fixed: on the "Everything" link, chat could be cut off or invisible when the OBS Browser Source was smaller than the layout canvas (OBS defaults to 800x600), especially with Custom CSS made for YouTube's chat page. The Everything overlay now always renders at the canvas size and scales as one picture to fit the source, so it looks the same at any size. The dock warns when the source size doesn't match the canvas. The default Chat box is wider (640 px). The Formal control panel style was removed.

## New in version 1.8

GIFs have one on/off switch that covers everything GIF-related, plus a choice of where they appear: Chat or Layout box. Polls can appear at the top of chat (works on a "Chat only" source) or in the Layout box, and each option's vote command can be renamed (defaults `!vote1` to `!vote6`; `!vote 1` still works). Style now has a clear Template / Custom CSS switch (only one can be active), color editing only on the Default template, a new Light template, all animation settings, and the control panel's own look: Light or Dark. The Test button has a "Type like a viewer" box and a Clear chat button.

## New in version 1.7

Battles are replaced by chat polls (`!vote 2`; start them from the new Polls section, or mods can type `!poll Question | A | B`). There's a Dark theme and a Speech bubble entrance where messages puff out of the avatar from a random side. Busy chat now pauses each message briefly so people can read it. Custom CSS mode has no built-in look at all anymore, and switching themes clears old messages. Every test lives in one Test button in the bottom-right corner. Platforms connect with a Connect button (then Reconnect / Disconnect). GIFs fill their box from Layout. Fixed: Twitch staying yellow while chat worked, and the edge fade is now smooth.

## New in version 1.6

The dock has a new blue and orange look and a tab bar again; "Look" is now called "Style". Custom CSS is now its own theme: pick "Custom CSS" in Style and chat is built with the same structure as YouTube's chat page, so CSS made for YouTube live chat works for YouTube, Twitch and TikTok messages alike. Save as many CSS presets as you like (up to 3 MB each, embedded images included) or load a .css file. The Layout section has a full-screen editor with a live preview of your overlay, and it warns you when your OBS source isn't the "Everything" link (the only one Layout moves). The dock also tells you when an OBS source is still running an older overlay and needs a Refresh.

This version also fixes a crash: very large CSS sent from the dock used to stop the whole app.

## Earlier changes

## New in this version

The dock's tabs are now one dropdown menu at the top. The new Layout section arranges chat, GIFs and battles inside the single "Everything" Browser Source: drag to move, drag the corner to resize, with grid snapping, locking, hiding and exact numbers. Set that Browser Source to the same size as the canvas (1920x1080 by default, or 1080x1920 for vertical).

Look adds the Kawaii (VTuber) theme, an edge fade for the top and bottom of chat, the platform logo on the avatar's corner (or the card's corner), and a Custom CSS box. Animation holds the Animation mode (Slide up, Fade and slide, Cloud, Pop, or a slide from either side), plus speed and pause.

## Size, colors and platform badge

In the Look tab, "Chat column width" sets how wide the chat area is and "Card max width" sets how wide a card can grow before its text wraps. Both are in pixels, and neither can exceed your Browser Source width, so set the source size in OBS first.

Themes: Clean, Sakura, Midnight Gold and Glass (dark see-through cards). Glass can't blur your game or camera behind it, because a Browser Source can't see the OBS layers underneath; for a real blur, use an OBS blur filter plugin on those layers.

Untick "Use the theme's colors" to pick your own card background and border color. Text switches to light automatically on dark backgrounds. "Card background opacity" works with any theme; below 70% the shadow is removed so see-through cards stay clean.

Under "Platform logo", one switch shows the platform's logo in each card's top-right corner and another shows a small colored dot on the avatar. Use either, both, or neither. YouTube, Twitch and TikTok logos are included; "Replace" swaps one for your own image and "Reset" brings the default back.

## Where GIFs show

In the GIFs tab, Display picks between a separate spot (one GIF at a time, from a queue), inside chat (the GIF fills a chat card under the viewer's name and scrolls away like any message), or both at once. GIFs inside chat are sized by "Card max width" in the Look tab. For the separate spot, click one of the 9 squares to place it (top left, center, bottom right, and so on) and use the height slider to size it. Changes show up on stream instantly, no refresh needed.

"Remove last GIF" in the dock, or `!skipgif` from you or a mod in chat, removes the newest GIF from the separate spot and from chat at the same time.

## Your own GIFs (custom commands)

Open the Custom tab, type a command name like `x03`, pick a GIF, PNG, WEBP or JPG (up to 8 MB), and press Add command. Viewers then type `!x03` and it shows wherever GIFs show. Custom commands share the `!gif` cooldowns but don't use any GIPHY searches, so they work even without a GIPHY key. Uploading again with the same name replaces the file. You can have up to 50. The files live in `data/custom`.

Only files are accepted whose contents really are GIF, PNG, WEBP or JPG; renaming another file won't get past the check. SVG is refused on purpose because SVG files can contain scripts.

## Security

This app was built with the September 2026 OBS research in mind, where a Twitch overlay that inserted chat as raw HTML let a single chat message run code on the streamer's PC.

Chat is never inserted as HTML. The overlay builds every message with plain text only. Viewers can't send links or images; only avatars and emotes from the platforms' own image servers, and GIFs from GIPHY's servers, are allowed. The overlay page also has a strict Content Security Policy, so even a mistake could not load outside scripts. The app only listens on `127.0.0.1`, so nothing on your network or the internet can reach it, and the control panel needs your private token. The test messages include a fake attack line so you can see it appear as harmless text.

Still update OBS to the latest version. The researchers found older OBS builds shipped an outdated browser engine, and OBS is shipping a newer one.

## Honest limits

TikTok has no official way to read live chat, and YouTube's official API has a daily quota, so by default this app uses the same unofficial methods other chat tools use (for YouTube you can switch to the official API with your own key, see Connect your channels). If either platform changes its website, that connection can stop working until the connector file is updated. Each platform runs separately, so one breaking never stops the others. Twitch avatars come from decapi.me, a free community service; if it is down, viewers get a letter avatar.

## Files

`data/config.json` holds your settings, keys and dock token. Don't share it. Delete it to reset everything (you'll get a new dock link). `data/battle-stats.json` holds the leaderboard. `npm test` runs the offline tests. `public/motion/` plays the Curve, Accordion and Liquid arrivals.
