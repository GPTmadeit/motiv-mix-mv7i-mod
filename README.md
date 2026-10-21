# MV7i Touch Panel Mod for Shure MOTIV Mix

A free, unofficial mod for the **Shure MOTIV Mix** desktop app (Windows). It lets the **MV7i**'s touch panel toggle **reverb** instead of (or as well as) muting, and turns the mic's lights **green while reverb is on**.

> [!WARNING]
> **Not affiliated with Shure. Made with no intent of making money.**
>
> - This is an **unofficial community project**. It is not affiliated with, endorsed by, or supported by Shure Incorporated. *Shure*, *MOTIV* and *MV7i* are trademarks of Shure Incorporated.
> - This mod is **free**. It was made with **no intent of making money from Shure's work**, and it must never be sold, paywalled, or bundled for profit.
> - **No Shure software is included in this repository or its releases.** The installer modifies the copy of MOTIV Mix that is already installed on your PC and keeps a backup of the original so you can remove the mod at any time.
> - Modifying MOTIV Mix may go against Shure's software license. **Use it at your own risk.** There is no warranty of any kind.
>
> The installer shows this notice and asks you to accept it before the first install.

## Features

| | |
|---|---|
| **Touch panel tap action** | Choose what a tap on the MV7i's touch panel does: **Mute** (stock), **Reverb on/off**, or **Mute + reverb on/off**. |
| **Double tap to switch modes** | **Tap** the touch panel to do the current action (mute, or reverb on/off). **Double tap** it to switch between **Reverb mode** and **Mute mode**, with no need to open the app. Can be switched off. |
| **Green lights for reverb** | While reverb is on, the touch panel lights turn green instead of the usual colour, so you can see it at a glance. Your own light colours come back when reverb turns off. Can be switched off. |
| **Both windows** | The settings appear on the MV7i page in the full MOTIV Mix window **and** in the small tray window. |
| **In-app updates** | The mod checks this GitHub repository for new releases and shows an **Install update** button. One click downloads the new installer, verifies its checksum, and installs it. |
| **One-file installer** | A single `MV7i-Mod-Installer.cmd`: double-click to install, update or uninstall. |

### Tap and double tap

| Gesture | Mute mode | Reverb mode |
|---|---|---|
| Single tap | Mute / unmute (instant) | Reverb on / off |
| Double tap | Switch to Reverb mode | Switch to Mute mode |

- **Double tap speed** is set in the mod panel: *Fast (0.5 s)*, *Normal (0.8 s)* (default), *Relaxed (1.2 s)*, or *Off*. It's the longest gap between the two taps that still counts as a double tap.
- A double tap leaves the mute as it was: the mic mutes on the first tap and unmutes on the second.
- To tell a single tap from a double tap, the mod waits for that window before acting. So in Reverb mode a single tap takes effect (and the mic unmutes) after the window. Mute mode is always instant, because the mic mutes on its own. Set double tap to *Off* for no delay.
- The panel's status line shows what the mod last detected, e.g. `last: double tap (0.31 s apart)` or `last: single tap`. If your double taps show up as two single taps, choose a slower setting.

> A press-and-hold gesture isn't possible: the mic only tells MOTIV Mix that its mute changed, not how long the panel was touched.

In **Reverb on/off** mode the mic firmware still mutes on a tap, and the mod un-mutes it straight away, so you may see the lights flash red for a moment before going green (reverb on) or back to your normal colour (reverb off).

## Install

1. Install [MOTIV Mix](https://www.shure.com/en-US/products/software/motiv-mix) from Shure and make sure it sees your MV7i.
2. Download **`MV7i-Mod-Installer.cmd`** from the [latest release](../../releases/latest).
3. Double-click it.
   - If Windows SmartScreen says *"Windows protected your PC"*, click **More info → Run anyway**. (The file is a plain-text script; you can open it in Notepad to read it first.)
   - Accept the administrator (UAC) prompt. MOTIV Mix is installed in *Program Files*, so admin rights are needed to change it.
4. Read the notice, type `YES`, and let it finish. It closes MOTIV Mix if it is running and offers to reopen it.
5. In MOTIV Mix, select your MV7i. At the bottom of its page you'll find:
   - **Touch panel tap**: Mute (default) / Reverb on/off / Mute + reverb on/off
   - **Double tap switches reverb/mute** (Off / Fast / Normal / Relaxed)
   - **Green lights while reverb is on**
   - the mod status, version, and update button

## Update

- **From inside MOTIV Mix:** when a new version is released, the mod's panel shows **Install update**. Click it, accept the admin prompt, and MOTIV Mix restarts with the new version. You can also click **Check for updates** at any time.
- **Manually:** download the newest installer from Releases and run it, then choose **Update / reinstall**.

If **Shure updates MOTIV Mix**, the update replaces the mod. Run the installer again afterwards. If the new MOTIV Mix version changed the code the mod hooks into, the installer says so and changes nothing; wait for a mod release that supports it.

## Uninstall

Run the installer again and choose **Uninstall**, which restores the original MOTIV Mix from the backup. Reinstalling MOTIV Mix from Shure also removes the mod.

## Compatibility

| | |
|---|---|
| MOTIV Mix | **1.10.0.133** (Windows x64) tested. Other versions are checked at install time and refused safely if they don't match. |
| Microphone | Shure **MV7i** (other devices are left untouched) |
| OS | Windows 10 / 11 |

## Troubleshooting

The mod writes a log to:

```
%LOCALAPPDATA%\Shure\MOTIV Mix\tap-action.log
```

It records the MV7i model name, which mute/reverb/light properties were found, every tap, and any errors. Please attach it when [opening an issue](../../issues).

The grey status line in the mod panel also tells you what it sees, e.g. `MV7i mod: ready` or `MV7i not detected (seen: ...)`.

## How it works

MOTIV Mix is an Electron app, so its logic is JavaScript inside `resources\app.asar`. The installer:

1. Backs up the original `app.asar` as `app.asar.mod-original`.
2. Inserts three small hooks into MOTIV Mix's device manager, so the mod can see device connections, the app's own property writes, and the device description.
3. Adds `tap-action.js` (the mod) and a small bridge for the settings panel, then writes the new archive.

The patching runs locally with MOTIV Mix's own built-in Node runtime, so nothing else needs to be installed.

At runtime the mod reads the MV7i's real property names from MOTIV Mix's device description and subscribes to the mic's mute and reverb state. A tap shows up as a mute change the app didn't make itself; the mod then toggles `AUDIO:REVERB_ENABLE` (and in reverb-only mode restores the mute). While reverb is on, it sets the touch panel's light theme to *Custom* green (`UI:*_METER_*` properties) and restores your previous values afterwards.

### Repository layout

```
src/tap-action.js       the mod that runs inside MOTIV Mix
src/patcher.js          reads/patches app.asar (run by the installer)
installer/installer.ps1 the installer UI (PowerShell)
build.js                bundles everything into dist/MV7i-Mod-Installer.cmd
tests/                  tests with a simulated MV7i
```

### Build from source

Requires Node.js 18+.

```sh
node tests/test-tap-action.js               # runtime tests with a simulated MV7i
node tests/test-patcher.js <path to an original app.asar>   # patcher tests
node build.js                               # writes dist/MV7i-Mod-Installer.cmd and .sha256
```

Releases attach `MV7i-Mod-Installer.cmd` and `MV7i-Mod-Installer.cmd.sha256`. The in-app updater looks for those two files and refuses the download if the checksum doesn't match.

## License

The mod's own code is released under the [MIT License](LICENSE). It doesn't cover MOTIV Mix itself, which belongs to Shure Incorporated.
