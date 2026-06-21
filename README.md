# Piper TTS

A Visual Studio Code extension that adds high-quality local text-to-speech capabilities using [Piper](https://github.com/rhasspy/piper).

## Features

- **Read Selected Text Aloud**: Easily convert selected text to speech with a single command
- **Terminal Selection Support**: Select text in the integrated terminal and read it aloud via right-click context menu
- **Multiple Languages and Voices**: Support for 40+ languages with 100+ voice options
- **Local Processing**: All text-to-speech processing happens locally on your machine, with no data sent to external servers
- **Cross-Platform**: Works on Windows and Linux
- **Voice Management**: Download additional voices or remove existing ones
- **API for Other Extensions**: Can be used by other VS Code extensions

## Prerequisites

### Linux
Install a clipboard utility to read terminal selections:
- **X11:** `sudo apt install xclip` (Debian/Ubuntu) or `sudo dnf install xclip` (Fedora)
- **Wayland:** `sudo apt install wl-clipboard` (Debian/Ubuntu) or `sudo dnf install wl-clipboard` (Fedora)

## Installation

1. Install the extension from the [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sethmiller.piper-tts)
2. The extension comes with two default English voices pre-installed:
   - `en_US-hfc_female-medium` (default)
   - `en_US-hfc_male-medium`

## Usage

### Reading Text Aloud

#### From Editor
1. Select text in the editor
2. Right-click and select "Read Aloud Text" from the context menu, or:
3. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run "Piper TTS: Read Aloud Text"

#### From Integrated Terminal
1. Select text in the terminal (click and drag)
2. Right-click and select "Read Aloud Text" from the context menu, or:
3. Open the Command Palette and run "Piper TTS: Read Aloud Text"

### Stopping Playback

- Right-click in the editor and select "Stop Reading", or:
- Open the Command Palette and run "Piper TTS: Stop Reading"

### Changing Voices

1. Open the Command Palette and run "Piper TTS: Select Voice"
2. Choose from the available installed voices

### Downloading Additional Voices

1. Open the Command Palette and run "Piper TTS: Download Voice"
2. Select a language, voice, and model size
3. Wait for the download to complete

### Removing Voices

1. Open the Command Palette and run "Piper TTS: Remove Voice"
2. Select the voice you want to remove

## Available Voices

The extension supports over 100 voices across 40+ languages. Some of the supported languages include:

- Arabic (ar_JO)
- Catalan (ca_ES)
- Czech (cs_CZ)
- Danish (da_DK)
- Dutch (nl_BE, nl_NL)
- English (en_GB, en_US)
- Finnish (fi_FI)
- French (fr_FR)
- German (de_DE)
- Greek (el_GR)
- Hungarian (hu_HU)
- Icelandic (is_IS)
- Italian (it_IT)
- Kazakh (kk_KZ)
- Norwegian (no_NO)
- Polish (pl_PL)
- Portuguese (pt_BR, pt_PT)
- Romanian (ro_RO)
- Russian (ru_RU)
- Spanish (es_ES, es_MX)
- Swedish (sv_SE)
- Turkish (tr_TR)
- Ukrainian (uk_UA)
- Vietnamese (vi_VN)
- Chinese (zh_CN)
- And many more...

Each language offers multiple voice options with different quality levels (x_low, low, medium, high).

## Voice Quality Levels

Voices come in different quality levels, which affect both the speech quality and resource usage:

- **x_low**: Smallest models, fastest processing, lowest quality
- **low**: Small models, fast processing, decent quality
- **medium**: Balanced models, good quality with reasonable resource usage
- **high**: Largest models, highest quality, but more resource-intensive

## Using the API

Other VS Code extensions can use Piper TTS functionality by accessing its API. See [API_USAGE.md](API_USAGE.md) for details.

## Extension Settings

- `piper-tts.voice`: The voice model to use for text-to-speech

## Known Issues

- Please report any issues you encounter.

## License

This extension is licensed under the terms of the [MIT LICENSE](LICENSE).

## Contributing

If you would like to contribute to this project, please fork the repository and submit a pull request. Contributions are welcome!

## Credits

- [Piper](https://github.com/rhasspy/piper) - The text-to-speech engine used by this extension
- [Sox](http://sox.sourceforge.net/) - Used for audio processing on Windows
- Voice models are sourced from the [Piper voices collection](https://huggingface.co/rhasspy/piper-voices)