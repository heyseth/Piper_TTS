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

// ponytail: xclip/wl-paste/pbpaste/clip.exe — the only reliable way to read terminal selections (VS Code's clipboard API ≠ system clipboard)
async function readSystemClipboard(): Promise<string | undefined> {
    const cmds = os.platform() === 'darwin'
        ? [{ command: 'pbpaste', args: [] }]
        : os.platform() === 'win32'
            ? [{ command: 'powershell', args: ['-NoProfile', '-Command', 'Get-Clipboard'] }]
            : [
                { command: 'xclip', args: ['-selection', 'clipboard', '-out'] },
                { command: 'wl-paste', args: ['-no-newline'] }, // ponytail: Wayland fallback
            ];

    for (const cmd of cmds) {
        let out = '';
        const result = await new Promise<string | undefined>((resolve) => {
            try {
                const proc = spawn(cmd.command, cmd.args);
                proc.stdout.on('data', (d: Buffer) => out += d.toString());
                proc.on('close', (code) => resolve(code === 0 ? out.trim() : undefined));
                proc.on('error', () => resolve(undefined));
            } catch {
                resolve(undefined);
            }
        });
        if (result !== undefined) return result;
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
        readText: async (text: string) => {
            try {
                if (!text) {
                    throw new Error('No text provided');
                }

                // Stop any current playback
                stopCurrentPlayback();

                // Small delay to ensure any file operations are complete
                await new Promise(resolve => setTimeout(resolve, 100));

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

                // Create piper process with full path
                const piper = spawn(piperPath, ['--model', voicePath, '--output-raw'], {
                    cwd: path.dirname(piperPath),
                    env: { ...process.env },
                    windowsHide: false
                });
                piperProcess = piper;

                // Create playback process
                const player = spawn(playback.command, playback.args);
                playerProcess = player;

                // Handle process output for debugging
                piper.stdout.on('data', (data) => {
                    console.log('Piper output:', data.toString());
                });

                piper.stderr.on('data', (data) => {
                    console.error('Piper error output:', data.toString());
                });

                player.stdout.on('data', (data) => {
                    console.log('Player output:', data.toString());
                });

                player.stderr.on('data', (data) => {
                    console.error('Player error output:', data.toString());
                });

                // Pipe the text through piper and to the playback command
                piper.stdout.pipe(player.stdin);
                piper.stdin.write(text);
                piper.stdin.end();

                // Return a promise that resolves when playback is complete
                return new Promise((resolve, reject) => {
                    piper.on('error', (error) => {
                        console.error('Piper error:', error);
                        reject(error);
                    });

                    player.on('error', (error) => {
                        console.error('Playback error:', error);
                        reject(error);
                    });

                    // Clean up processes
                    piper.on('close', (code) => {
                        console.log('Piper process exited with code:', code);
                        piperProcess = undefined;
                        // Only reject if the process wasn't killed intentionally
                        if (code !== 0 && code !== null) {
                            reject(new Error(`Piper process exited with code: ${code}`));
                        } else {
                            resolve();
                        }
                    });

                    player.on('close', (code) => {
                        console.log('Player process exited with code:', code);
                        playerProcess = undefined;
                        if (code === 0) {
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
        },
        stopPlayback: () => {
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
        let text: string | undefined;

        // Try editor selection first
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            text = editor.document.getText(editor.selection);
        }

        // Fallback: copy terminal selection, then read system clipboard
        if (!text?.trim() && vscode.window.activeTerminal) {
            await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
            await new Promise(r => setTimeout(r, 100)); // ponytail: lets copy propagate to system clipboard
            text = await readSystemClipboard();
        }

        if (!text?.trim()) {
            vscode.window.showInformationMessage('Please select some text to read aloud (copy terminal text first)');
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
}
