import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { fixSymlinks } from './symlinkUtils';

let piperProcess: ReturnType<typeof spawn> | undefined;
let playerProcess: ReturnType<typeof spawn> | undefined;

// Playback speed bounds. Speed is a multiplier (1 = normal, higher = faster) and
// maps to Piper's --length_scale as length_scale = 1 / speed.
const SPEED_MIN = 0.5;
const SPEED_MAX = 3;
const SPEED_STEP = 0.25;

// Rough speaking rate at speed 1.0 for the bundled voices, used only to estimate how
// far playback has progressed when the speed is changed mid-utterance.
const BASE_CHARS_PER_SEC = 14;

// The extension context and the utterance currently being spoken, tracked so a speed
// change can re-synthesize the remaining text in real time.
let currentContext: vscode.ExtensionContext | undefined;
let currentUtterance: { text: string; startTime: number; token: object } | undefined;

// Status bar indicator shown briefly when the speed changes.
let speedStatusBarItem: vscode.StatusBarItem | undefined;
let speedIndicatorTimer: ReturnType<typeof setTimeout> | undefined;

function clampSpeed(value: number): number {
    if (typeof value !== 'number' || !isFinite(value)) {
        return 1;
    }
    return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value));
}

function getSpeed(): number {
    return clampSpeed(vscode.workspace.getConfiguration('piper-tts').get<number>('speed') ?? 1);
}

// Context key reflecting whether audio is actively playing, so menus (e.g. "Stop
// Reading") can be shown only while something is being read.
const PLAYING_CONTEXT = 'piper-tts.isPlaying';
function setPlayingContext(playing: boolean): void {
    void vscode.commands.executeCommand('setContext', PLAYING_CONTEXT, playing);
}

function showSpeedIndicator(speed: number): void {
    if (!speedStatusBarItem) {
        return;
    }
    speedStatusBarItem.text = `$(megaphone) Piper ${speed}×`;
    speedStatusBarItem.tooltip = 'Piper TTS playback speed';
    speedStatusBarItem.show();
    if (speedIndicatorTimer) {
        clearTimeout(speedIndicatorTimer);
    }
    speedIndicatorTimer = setTimeout(() => speedStatusBarItem?.hide(), 3000);
}

// Preset speeds offered in the right-click "Reading Speed" submenu.
const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

// Turns a preset value into a stable command id suffix, e.g. 0.5 -> "0_5", 1 -> "1".
function speedCommandId(value: number): string {
    return `piper-tts.setSpeed_${String(value).replace('.', '_')}`;
}

// Set the playback speed to `next` (clamped). The value is persisted to user settings
// (remembered across sessions) and shown in the status bar. If something is currently
// playing, the change takes effect immediately:
//   - On Windows (seamless mode) the player is restarted from the current position with
//     a new sox `tempo` — no Piper reload, so it is effectively gapless.
//   - Elsewhere the remaining text is re-synthesized at the new speed.
async function applySpeed(next: number): Promise<void> {
    const current = getSpeed();
    next = clampSpeed(next);

    // Persist the new speed first, so any re-synthesis below picks it up via getSpeed().
    await vscode.workspace.getConfiguration('piper-tts').update('speed', next, vscode.ConfigurationTarget.Global);
    showSpeedIndicator(next);
    if (next === current) { return; }

    // Windows: apply seamlessly (or re-synthesize the remainder if still synthesizing).
    if (seamlessSpeedChange(next)) { return; }

    // Other platforms: re-synthesize the not-yet-spoken text (estimated from the old
    // speed) at the new speed so the change takes effect immediately.
    if (!IS_WINDOWS && currentContext && currentUtterance && playerProcess) {
        const utterance = currentUtterance;
        const elapsedSeconds = (Date.now() - utterance.startTime) / 1000;
        const spokenChars = Math.floor(elapsedSeconds * BASE_CHARS_PER_SEC * current);
        let offset = Math.min(utterance.text.length, Math.max(0, spokenChars));
        // Snap forward to a word boundary so we don't restart mid-word.
        const nextSpace = utterance.text.indexOf(' ', offset);
        if (nextSpace !== -1) {
            offset = nextSpace + 1;
        }
        const rest = utterance.text.slice(offset);
        if (rest.trim()) {
            synthesizeAndPlay(currentContext, rest, { immediate: true }).catch(error => console.error('Failed to restart playback at new speed:', error));
        }
    }
}

// Adjust the configured speed by `delta`, snapping to the step grid so values stay
// clean (…, 0.75, 1, 1.25, …) and clamped to [SPEED_MIN, SPEED_MAX].
async function adjustSpeed(delta: number): Promise<void> {
    await applySpeed(Math.round((getSpeed() + delta) / SPEED_STEP) * SPEED_STEP);
}

// ---- Seamless speed (Windows) ----
// Piper reloads its model on every spawn (a multi-second cost), so re-synthesizing on
// each speed change is never gapless. On Windows the bundled sox `play.exe` supports the
// pitch-preserving `tempo` effect and `trim`. So we stream Piper's output to the player
// (for an instant start) while also teeing the raw audio to a file; once that file is
// complete, a speed change restarts only the player from the current offset with a new
// tempo — gapless, no Piper reload. If the speed is changed before synthesis finishes,
// we fall back to re-synthesizing the remainder (the previous behaviour). Other platforms
// (aplay/afplay) lack these effects and always use the re-synthesis path.
const IS_WINDOWS = os.platform() === 'win32';
const RAW_SAMPLE_RATE = 22050;
const RAW_BYTES_PER_SEC = RAW_SAMPLE_RATE * 2; // 16-bit mono

let currentPlayback: {
    token: object;
    file: string;
    text: string;            // full text, so an early speed change can re-synthesize
    durationSec: number;     // known once synthesis (the temp file) completes
    synthComplete: boolean;  // temp file fully written — safe to seek for tempo changes
    originOffsetSec: number; // offset (in the 1x file) where the current player started
    startWall: number;       // Date.now() when the current player started
    tempo: number;           // current playback tempo (= speed)
} | undefined;

function cleanupPlaybackFile(): void {
    const file = currentPlayback?.file;
    if (file) {
        try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
}

// Mark this playback finished — unless a newer one has already superseded it (a speed
// change reuses the same file under a new token).
function finalizeSeamless(token: object): void {
    if (currentPlayback && currentPlayback.token === token) {
        cleanupPlaybackFile();
        currentPlayback = undefined;
        setPlayingContext(false);
    }
}

function soxPlayPath(context: vscode.ExtensionContext): string {
    return path.join(path.resolve(context.extensionUri.fsPath, ''), 'sox', 'play.exe');
}

// Player that reads a completed raw file, seeking to `offsetSec` and applying `tempo`.
function spawnSoxFilePlayer(context: vscode.ExtensionContext, file: string, offsetSec: number, tempo: number) {
    return spawn(soxPlayPath(context), [
        '-t', 'raw', '-r', String(RAW_SAMPLE_RATE), '-b', '16', '-e', 'signed', '-c', '1', '-L',
        file,
        'trim', Math.max(0, offsetSec).toFixed(3),
        'tempo', tempo.toFixed(3),
        'remix', '1'
    ]);
}

// Player that reads raw audio from stdin (streamed from Piper) applying `tempo`.
function spawnSoxStreamPlayer(context: vscode.ExtensionContext, tempo: number) {
    return spawn(soxPlayPath(context), [
        '-t', 'raw', '-r', String(RAW_SAMPLE_RATE), '-b', '16', '-e', 'signed', '-c', '1', '-L',
        '-',
        'tempo', tempo.toFixed(3),
        'remix', '1'
    ]);
}

function attachSeamlessHandlers(player: ReturnType<typeof spawn>, token: object, resolve?: () => void, reject?: (e: Error) => void): void {
    player.on('error', (error) => {
        console.error('Playback error:', error);
        finalizeSeamless(token);
        if (reject) { reject(error); }
    });
    player.on('close', (code) => {
        if (playerProcess === player) {
            playerProcess = undefined;
        }
        finalizeSeamless(token);
        if (code === 0 || code === null) {
            if (resolve) { resolve(); }
        } else if (reject) {
            reject(new Error(`Player process exited with code: ${code}`));
        }
    });
}

// Windows seamless playback: stream Piper -> player for an instant start, while teeing
// the raw audio to a temp file so later speed changes can re-time it without re-synth.
async function synthesizeAndPlaySeamless(context: vscode.ExtensionContext, text: string): Promise<void> {
    if (!text) { throw new Error('No text provided'); }

    // Stop and clear any previous playback (and remove its temp file).
    stopCurrentPlayback();
    cleanupPlaybackFile();
    currentPlayback = undefined;

    const piperPath = getPiperPath(context);
    const voicePath = getVoicePath(context);
    if (!fs.existsSync(piperPath)) { throw new Error(`Piper executable not found at: ${piperPath}`); }
    if (!fs.existsSync(voicePath)) { throw new Error(`Voice model not found at: ${voicePath}`); }

    const file = path.join(os.tmpdir(), `piper-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.raw`);
    const tempo = getSpeed();
    const token = {};

    // Synthesize at normal length scale (1.0); speed is applied by the player's tempo.
    const piper = spawn(piperPath, ['--model', voicePath, '--output-raw', '--length_scale', '1.000'], {
        cwd: path.dirname(piperPath),
        env: { ...process.env },
        windowsHide: false
    });
    piperProcess = piper;
    const player = spawnSoxStreamPlayer(context, tempo);
    playerProcess = player;

    const out = fs.createWriteStream(file);
    piper.stdout.pipe(out);           // tee to file for seamless re-timing
    piper.stdout.pipe(player.stdin);  // stream to the player for an instant start
    piper.stderr.on('data', (d) => console.error('Piper error output:', d.toString()));

    currentPlayback = { token, file, text, durationSec: 0, synthComplete: false, originOffsetSec: 0, startWall: Date.now(), tempo };
    setPlayingContext(true);

    // When the temp file is fully written, mark synthesis complete and record duration.
    out.on('finish', () => {
        if (currentPlayback && currentPlayback.token === token) {
            currentPlayback.synthComplete = true;
            try { currentPlayback.durationSec = fs.statSync(file).size / RAW_BYTES_PER_SEC; } catch { /* ignore */ }
        }
    });

    piper.stdin.write(text);
    piper.stdin.end();

    return await new Promise<void>((resolve, reject) => {
        piper.on('error', (e) => { if (piperProcess === piper) { piperProcess = undefined; } finalizeSeamless(token); reject(e); });
        piper.on('close', () => { if (piperProcess === piper) { piperProcess = undefined; } });
        attachSeamlessHandlers(player, token, resolve, reject);
    });
}

// Apply a speed change to the current (Windows) playback. Returns true if it handled the
// change. Config must already be updated to `next` (a re-synth reads it via getSpeed()).
function seamlessSpeedChange(next: number): boolean {
    if (!IS_WINDOWS || !currentContext || !currentPlayback || !playerProcess) { return false; }
    const pb = currentPlayback;
    const elapsedSeconds = (Date.now() - pb.startWall) / 1000;

    if (pb.synthComplete) {
        // Gapless: restart only the player from the current offset with the new tempo.
        const offset = pb.originOffsetSec + elapsedSeconds * pb.tempo;
        if (offset >= pb.durationSec - 0.05) { return false; } // practically finished
        const token = {};
        // Reassign the tracked playback first, so the outgoing player's close handler
        // (fired by stopCurrentPlayback below) does not delete the shared temp file.
        currentPlayback = { ...pb, token, originOffsetSec: Math.max(0, offset), startWall: Date.now(), tempo: next };
        stopCurrentPlayback(); // kills the player only; the temp file is reused
        const player = spawnSoxFilePlayer(currentContext, pb.file, Math.max(0, offset), next);
        playerProcess = player;
        setPlayingContext(true);
        attachSeamlessHandlers(player, token);
        return true;
    }

    // Still synthesizing (temp file incomplete, can't seek it): re-synthesize the
    // remaining text at the new speed. Estimate the position from characters.
    const spokenChars = Math.floor(elapsedSeconds * BASE_CHARS_PER_SEC * pb.tempo);
    let charOffset = Math.min(pb.text.length, Math.max(0, spokenChars));
    const nextSpace = pb.text.indexOf(' ', charOffset);
    if (nextSpace !== -1) { charOffset = nextSpace + 1; }
    const rest = pb.text.slice(charOffset);
    if (rest.trim()) {
        synthesizeAndPlaySeamless(currentContext, rest).catch(e => console.error('Failed to restart playback at new speed:', e));
    }
    return true;
}

function getAvailableVoices(context: vscode.ExtensionContext): string[] {
    const parentDir = path.resolve(context.extensionUri.fsPath, '');
    const voicesDir = path.join(parentDir, 'voices');
    
    try {
        const files = fs.readdirSync(voicesDir);
        return files
            .filter(file => file.endsWith('.onnx'))
            .map(file => path.basename(file, '.onnx'));
    } catch (error) {
        console.error('Error reading voices directory:', error);
        return [];
    }
}

function getVoiceLabel(voice: string): string {
    // Convert the voice ID to a more readable format
    const parts = voice.split('-');
    const locale = parts[0].replace('_', ' ');
    const name = parts[1].replace(/_/g, ' ');
    const quality = parts[2] || '';
    return `${locale} - ${name} (${quality})`;
}

// Helper function to download a file from a URL
function downloadFile(url: string, destination: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        
        // Make sure the destination directory exists
        const destDir = path.dirname(destination);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        
        // If the file already exists, delete it first to avoid any issues
        if (fs.existsSync(destination)) {
            try {
                fs.unlinkSync(destination);
            } catch (err) {
                console.error(`Error removing existing file ${destination}:`, err);
            }
        }
        
        const file = fs.createWriteStream(destination, { flags: 'wx' });
        
        const request = protocol.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301 || response.statusCode === 307) {
                // Handle redirects
                if (response.headers.location) {
                    const redirectUrl = new URL(response.headers.location, url).toString();
                    // Close the current file before starting a new download
                    file.close();
                    downloadFile(redirectUrl, destination)
                        .then(resolve)
                        .catch(reject);
                    return;
                }
            }
            
            if (response.statusCode !== 200) {
                file.close();
                fs.unlink(destination, () => {});
                reject(new Error(`Failed to download file: ${response.statusCode} ${response.statusMessage}`));
                return;
            }
            
            response.pipe(file);
            
            file.on('finish', () => {
                // Explicitly flush to disk before closing
                file.end(() => {
                    file.close();
                    
                    // Verify the file exists and has content
                    try {
                        const stats = fs.statSync(destination);
                        if (stats.size === 0) {
                            reject(new Error(`Downloaded file is empty: ${destination}`));
                            return;
                        }
                        resolve();
                    } catch (err) {
                        const errorMessage = err instanceof Error ? err.message : String(err);
                        reject(new Error(`Error verifying downloaded file: ${errorMessage}`));
                    }
                });
            });
        });
        
        request.on('error', (err) => {
            file.close();
            fs.unlink(destination, () => {});
            reject(err);
        });
        
        file.on('error', (err) => {
            file.close();
            fs.unlink(destination, () => {});
            reject(err);
        });
    });
}

// Function to load and parse the voices.json file
function loadVoicesData(context: vscode.ExtensionContext): any {
    const parentDir = path.resolve(context.extensionUri.fsPath, '');
    const voicesJsonPath = path.join(parentDir, 'voices', 'voices.json');
    
    try {
        const voicesJson = fs.readFileSync(voicesJsonPath, 'utf8');
        return JSON.parse(voicesJson);
    } catch (error) {
        console.error('Error reading voices.json:', error);
        throw new Error('Failed to load voices data');
    }
}

// Function to download a voice model and its config
async function downloadVoice(context: vscode.ExtensionContext): Promise<void> {
    try {
        const voicesData = loadVoicesData(context);
        
        // Get list of languages
        const languages = Object.keys(voicesData);
        
        // Step 1: Let user select a language
        const selectedLanguage = await vscode.window.showQuickPick(languages, {
            placeHolder: 'Select a language',
        });
        
        if (!selectedLanguage) {
            return; // User cancelled
        }
        
        // Step 2: Let user select a voice for the chosen language
        const voices = Object.keys(voicesData[selectedLanguage]);
        const selectedVoice = await vscode.window.showQuickPick(voices, {
            placeHolder: `Select a voice for ${selectedLanguage}`,
        });
        
        if (!selectedVoice) {
            return; // User cancelled
        }
        
        // Step 3: Let user select a model size
        const modelSizes = Object.keys(voicesData[selectedLanguage][selectedVoice]);
        const selectedSize = await vscode.window.showQuickPick(modelSizes, {
            placeHolder: `Select a model size for ${selectedVoice}`,
        });
        
        if (!selectedSize) {
            return; // User cancelled
        }
        
        // Get the model and config URLs
        const modelUrl = voicesData[selectedLanguage][selectedVoice][selectedSize].model;
        const configUrl = voicesData[selectedLanguage][selectedVoice][selectedSize].config;
        
        // Create language code from the selected language (e.g., "English (en_US)" -> "en_US")
        const languageCode = selectedLanguage.match(/\(([^)]+)\)/)?.[1] || '';
        
        // Create voice ID (e.g., "en_US-amy-medium")
        const voiceId = `${languageCode}-${selectedVoice}-${selectedSize}`;
        
        // Create destination paths
        const parentDir = path.resolve(context.extensionUri.fsPath, '');
        const voicesDir = path.join(parentDir, 'voices');
        
        // Ensure voices directory exists
        if (!fs.existsSync(voicesDir)) {
            fs.mkdirSync(voicesDir, { recursive: true });
        }
        
        const modelPath = path.join(voicesDir, `${voiceId}.onnx`);
        const configPath = path.join(voicesDir, `${voiceId}.onnx.json`);
        
        // Show progress while downloading
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Downloading ${voiceId}`,
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Downloading model file...' });
            
            // Download model file
            await downloadFile(modelUrl, modelPath);
            
            progress.report({ message: 'Downloading config file...', increment: 50 });
            
            // Download config file
            await downloadFile(configUrl, configPath);
            
            progress.report({ message: 'Download complete', increment: 50 });
        });
        
        // Make sure any existing processes are stopped
        stopCurrentPlayback();
        
        // Add a small delay to ensure files are fully written and accessible
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Verify the downloaded files exist and are accessible
        if (!fs.existsSync(modelPath) || !fs.existsSync(configPath)) {
            throw new Error('Downloaded voice files not found or not accessible');
        }
        
        // Set the downloaded voice as the current voice
        await vscode.workspace.getConfiguration('piper-tts').update(
            'voice',
            voiceId,
            vscode.ConfigurationTarget.Global
        );
        
        // Ensure file handles are properly closed by forcing a garbage collection
        if (global.gc) {
            global.gc();
        }
        
        vscode.window.showInformationMessage(`Voice ${voiceId} has been downloaded and set as the current voice.`);
    } catch (error) {
        console.error('Error downloading voice:', error);
        vscode.window.showErrorMessage('Failed to download voice: ' + (error instanceof Error ? error.message : String(error)));
    }
}

async function selectVoice(context: vscode.ExtensionContext) {
    const voices = getAvailableVoices(context);
    
    if (voices.length === 0) {
        vscode.window.showErrorMessage('No voice models found in the voices directory');
        return;
    }

    const items = voices.map(voice => ({
        label: getVoiceLabel(voice),
        description: voice,
    }));

    const selection = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a voice for text-to-speech',
    });

    if (selection) {
        await vscode.workspace.getConfiguration('piper-tts').update(
            'voice',
            selection.description,
            vscode.ConfigurationTarget.Global
        );
    }
}

function getPiperPath(context: vscode.ExtensionContext): string {
    const platform = os.platform();
    const arch = os.arch();
    
    // Get absolute path to extension directory
    const extensionPath = context.extensionUri.fsPath;
    console.log('Extension path:', extensionPath);
    
    // Get parent directory
    const parentDir = path.resolve(extensionPath, '');
    console.log('Parent directory:', parentDir);
    
    // List files in parent directory for debugging
    try {
        const files = fs.readdirSync(parentDir);
        console.log('Files in parent directory:', files);
    } catch (error) {
        console.error('Error reading parent directory:', error);
    }

    let piperPath: string;
    switch (platform) {
        case 'win32':
            piperPath = path.join(parentDir, 'piper/windows_amd64', 'piper.exe');
            break;
        case 'darwin':
            if (arch === 'arm64') {
                piperPath = path.join(parentDir, 'piper/macos_aarch64', 'piper');
            } else {
                piperPath = path.join(parentDir, 'piper/macos_x64', 'piper');
            }
            break;
        case 'linux':
            if (arch === 'arm64') {
                piperPath = path.join(parentDir, 'piper/linux_aarch64', 'piper');
            } else if (arch === 'arm') {
                piperPath = path.join(parentDir, 'piper/linux_armv7l', 'piper');
            } else {
                piperPath = path.join(parentDir, 'piper/linux_x86_64', 'piper');
            }
            break;
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }

    console.log('Full Piper path:', piperPath);
    console.log('Path exists:', fs.existsSync(piperPath));
    return piperPath;
}

function getVoicePath(context: vscode.ExtensionContext): string {
    const config = vscode.workspace.getConfiguration('piper-tts');
    const selectedVoice = config.get<string>('voice') || 'en_US-hfc_female-medium';
    
    const parentDir = path.resolve(context.extensionUri.fsPath, '');
    const voicePath = path.join(parentDir, 'voices', `${selectedVoice}.onnx`);
    console.log('Voice path:', voicePath);
    console.log('Voice exists:', fs.existsSync(voicePath));
    return voicePath;
}

function getPlaybackCommand(context: vscode.ExtensionContext): { command: string, args: string[] } {
    const platform = os.platform();
    
    switch (platform) {
        case 'win32':
            const parentDir = path.resolve(context.extensionUri.fsPath, '');
            const playPath = path.join(parentDir, 'sox', 'play.exe');
            return { command: playPath, args: [
                '-t', 'raw',
                '-r', '22050',
                '-b', '16',
                '-e', 'signed',
                '-c', '1',
                '-L',
                '-',
                'remix', '1'
            ]};
        case 'darwin':
            return { command: 'afplay', args: ['-'] };
        case 'linux':
            return { command: 'aplay', args: ['-r', '22050', '-f', 'S16_LE', '-t', 'raw', '-'] };
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }
}

function stopCurrentPlayback() {
    try {
        if (piperProcess && !piperProcess.killed) {
            console.log('Stopping Piper process...');
            piperProcess.kill();
            piperProcess = undefined;
        }
        
        if (playerProcess && !playerProcess.killed) {
            console.log('Stopping player process...');
            playerProcess.kill();
            playerProcess = undefined;
        }
    } catch (error) {
        console.error('Error stopping playback:', error);
        // Reset process references even if kill fails
        piperProcess = undefined;
        playerProcess = undefined;
    }
}

async function removeVoice(context: vscode.ExtensionContext) {
    const voices = getAvailableVoices(context);
    
    if (voices.length === 0) {
        vscode.window.showErrorMessage('No voice models found in the voices directory');
        return;
    }

    const items = voices.map(voice => ({
        label: getVoiceLabel(voice),
        description: voice,
    }));

    const selection = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a voice to remove',
    });

    if (selection) {
        const voiceId = selection.description;
        const parentDir = path.resolve(context.extensionUri.fsPath, '');
        const modelPath = path.join(parentDir, 'voices', `${voiceId}.onnx`);
        const configPath = path.join(parentDir, 'voices', `${voiceId}.onnx.json`);

        try {
            // Delete the model file if it exists
            if (fs.existsSync(modelPath)) {
                fs.unlinkSync(modelPath);
            }
            // Delete the config file if it exists
            if (fs.existsSync(configPath)) {
                fs.unlinkSync(configPath);
            }

            vscode.window.showInformationMessage(`Voice ${voiceId} has been removed.`);

            // If this was the currently selected voice, reset to default
            const config = vscode.workspace.getConfiguration('piper-tts');
            const currentVoice = config.get<string>('voice');
            if (currentVoice === voiceId) {
                await config.update('voice', 'en_US-hfc_female-medium', vscode.ConfigurationTarget.Global);
            }
        } catch (error) {
            console.error('Error removing voice:', error);
            vscode.window.showErrorMessage('Failed to remove voice: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
}

// Synthesize `text` with Piper at the current speed and stream it to the audio
// player. Tracks the utterance so the speed can be changed mid-playback (see
// adjustSpeed). Resolves when playback finishes (or is stopped/superseded).
async function synthesizeAndPlay(context: vscode.ExtensionContext, text: string, options?: { immediate?: boolean }): Promise<void> {
    try {
        if (!text) {
            throw new Error('No text provided');
        }

        // Stop any current playback
        stopCurrentPlayback();

        // Small delay to ensure any file operations are complete. Skipped when
        // restarting for a speed change (options.immediate) to keep the change as
        // seamless as possible — nothing new is being written to disk in that case.
        if (!options?.immediate) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const piperPath = getPiperPath(context);
        const voicePath = getVoicePath(context);

        // Verify file existence
        if (!fs.existsSync(piperPath)) {
            throw new Error(`Piper executable not found at: ${piperPath}`);
        }
        if (!fs.existsSync(voicePath)) {
            throw new Error(`Voice model not found at: ${voicePath}`);
        }

        // Verify the voice file is accessible and not locked
        try {
            // Try to open the file to verify it's not locked
            const fd = fs.openSync(voicePath, 'r');
            fs.closeSync(fd);
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            throw new Error(`Voice model file is not accessible: ${errorMessage}`);
        }

        const playback = getPlaybackCommand(context);

        // Map the speed multiplier to Piper's --length_scale (inverse: a higher
        // speed means shorter phonemes, i.e. a smaller length scale).
        const lengthScale = (1 / getSpeed()).toFixed(3);

        // Create piper process with full path
        const piper = spawn(piperPath, ['--model', voicePath, '--output-raw', '--length_scale', lengthScale], {
            cwd: path.dirname(piperPath),
            env: { ...process.env },
            windowsHide: false
        });
        piperProcess = piper;

        // Create playback process
        const player = spawn(playback.command, playback.args);
        playerProcess = player;

        // Track this utterance so a speed change can resume the remainder in real time.
        const token = {};
        currentUtterance = { text, startTime: Date.now(), token };
        setPlayingContext(true);

        // Mark playback as finished for this utterance (unless it has already been
        // superseded by a newer one, e.g. via a speed change).
        const finalizeIfCurrent = () => {
            if (currentUtterance && currentUtterance.token === token) {
                currentUtterance = undefined;
                setPlayingContext(false);
            }
        };

        piper.stderr.on('data', (data) => {
            console.error('Piper error output:', data.toString());
        });

        player.stderr.on('data', (data) => {
            console.error('Player error output:', data.toString());
        });

        // Pipe the text through piper and to the playback command
        piper.stdout.pipe(player.stdin);
        piper.stdin.write(text);
        piper.stdin.end();

        // Return a promise that resolves when playback is complete
        return await new Promise<void>((resolve, reject) => {
            piper.on('error', (error) => {
                console.error('Piper error:', error);
                finalizeIfCurrent();
                reject(error);
            });

            player.on('error', (error) => {
                console.error('Playback error:', error);
                finalizeIfCurrent();
                reject(error);
            });

            // Clean up processes. Only clear the module-level reference if it still
            // points at *this* process — a speed change spawns a new piper/player, and
            // the old (killed) one's close event fires later; without this guard it
            // would wipe out the reference to the new, still-playing process.
            piper.on('close', (code) => {
                if (piperProcess === piper) {
                    piperProcess = undefined;
                }
                // Only reject if the process wasn't killed intentionally
                if (code !== 0 && code !== null) {
                    finalizeIfCurrent();
                    reject(new Error(`Piper process exited with code: ${code}`));
                } else {
                    resolve();
                }
            });

            player.on('close', (code) => {
                if (playerProcess === player) {
                    playerProcess = undefined;
                }
                // Clear the tracked utterance only if it is still this one (a speed
                // change starts a new utterance and supersedes the old one).
                finalizeIfCurrent();
                // code === null means the process was killed intentionally (stop, or a
                // speed change restarting playback) — treat that as a normal end.
                if (code === 0 || code === null) {
                    resolve();
                } else {
                    reject(new Error(`Player process exited with code: ${code}`));
                }
            });
        });
    } catch (error) {
        console.error('Error:', error);
        throw error;
    }
}

// API interface that will be exposed to other extensions
export interface PiperTTSApi {
    readText(text: string): Promise<void>;
    stopPlayback(): void;
    selectVoice(): Promise<void>;
    downloadVoice(): Promise<void>;
    removeVoice(): Promise<void>;
}

// This will be the exported API that other extensions can consume
let extensionApi: PiperTTSApi | undefined;

export function activate(context: vscode.ExtensionContext): PiperTTSApi {
    console.log('Piper TTS extension is now active!');
    console.log('Extension path:', context.extensionUri.fsPath);
    console.log('OS platform:', os.platform());
    console.log('OS architecture:', os.arch());
    
    // Fix symbolic links on Linux platforms before doing anything else
    if (os.platform() === 'linux') {
        fixSymlinks(context.extensionUri.fsPath).catch(error => {
            console.error('Failed to fix symbolic links:', error);
            // Continue execution even if symlink fix fails
        });
    }
    
    // Set execute permissions for Linux and macOS binaries
    if (os.platform() === 'linux' || os.platform() === 'darwin') {
        try {
            const parentDir = path.resolve(context.extensionUri.fsPath, '');
            const piperPath = getPiperPath(context);
            
            // Make the piper binary executable
            fs.chmodSync(piperPath, 0o755);
            console.log(`Set execute permissions for ${piperPath}`);
            
            // Also set permissions for other binaries that might be needed
            const binDir = path.dirname(piperPath);
            const otherBinaries = ['espeak-ng', 'piper_phonemize'];
            
            for (const binary of otherBinaries) {
                const binaryPath = path.join(binDir, binary);
                if (fs.existsSync(binaryPath)) {
                    fs.chmodSync(binaryPath, 0o755);
                    console.log(`Set execute permissions for ${binaryPath}`);
                }
            }
        } catch (error) {
            console.error('Error setting execute permissions:', error);
        }
    }

    // Create the API implementation
    const api: PiperTTSApi = {
        readText: (text: string) => IS_WINDOWS ? synthesizeAndPlaySeamless(context, text) : synthesizeAndPlay(context, text),
        stopPlayback: () => {
            currentUtterance = undefined;
            cleanupPlaybackFile();
            currentPlayback = undefined;
            setPlayingContext(false);
            stopCurrentPlayback();
        },
        selectVoice: () => selectVoice(context),
        downloadVoice: () => downloadVoice(context),
        removeVoice: () => removeVoice(context)
    };

    // Register commands to use the API
    let selectVoiceDisposable = vscode.commands.registerCommand('piper-tts.selectVoice', () => api.selectVoice());
    context.subscriptions.push(selectVoiceDisposable);

    const readAloudDisposable = vscode.commands.registerCommand('piper-tts.readAloud', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const selection = editor.selection;
        const text = editor.document.getText(selection);

        if (!text) {
            vscode.window.showInformationMessage('Please select some text to read aloud');
            return;
        }

        try {
            await api.readText(text);
        } catch (error) {
            vscode.window.showErrorMessage('Error running text-to-speech: ' + (error instanceof Error ? error.message : String(error)));
        }
    });
    context.subscriptions.push(readAloudDisposable);

    const stopDisposable = vscode.commands.registerCommand('piper-tts.stopPlayback', () => api.stopPlayback());
    context.subscriptions.push(stopDisposable);

    const downloadVoiceDisposable = vscode.commands.registerCommand('piper-tts.downloadVoice', () => api.downloadVoice());
    context.subscriptions.push(downloadVoiceDisposable);

    const removeVoiceDisposable = vscode.commands.registerCommand('piper-tts.removeVoice', () => api.removeVoice());
    context.subscriptions.push(removeVoiceDisposable);

    // Speed controls: adjust the playback speed multiplier. If something is playing,
    // the change is applied in real time (the remainder is re-synthesized).
    currentContext = context;
    speedStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(
        speedStatusBarItem,
        vscode.commands.registerCommand('piper-tts.increaseSpeed', () => adjustSpeed(SPEED_STEP)),
        vscode.commands.registerCommand('piper-tts.decreaseSpeed', () => adjustSpeed(-SPEED_STEP))
    );

    // Preset speeds for the right-click "Reading Speed" submenu.
    for (const preset of SPEED_PRESETS) {
        context.subscriptions.push(
            vscode.commands.registerCommand(speedCommandId(preset), () => applySpeed(preset))
        );
    }

    // Store the API in our module-level variable so it can be accessed by getApi
    extensionApi = api;
    
    // Return the API for other extensions to use
    return api;
}

/**
 * This function allows other extensions to get access to the Piper TTS API
 * They can use it like this:
 * ```
 * const piperExtension = vscode.extensions.getExtension('sethmiller.piper-tts');
 * if (piperExtension) {
 *   const piperApi = await piperExtension.activate();
 *   await piperApi.readText('Hello world');
 * }
 * ```
 */
export function getApi(): PiperTTSApi | undefined {
    return extensionApi;
}

export function deactivate() {
    stopCurrentPlayback();
    cleanupPlaybackFile();
}
