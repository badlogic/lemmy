import { execSync } from "child_process";
import { readFileSync, readdirSync, statSync, mkdirSync, existsSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { platform } from "os";
import { fileURLToPath } from "url";

/**
 * Get current platform with enhanced Windows detection for WSL scenarios
 * @returns Platform string compatible with platform detection
 */
function getCurrentPlatform(): string {
	// Force Windows detection if we're in WSL or actual Windows
	if (process.env.WSL_DISTRO_NAME || process.platform === 'win32') {
		return 'win32';
	}
	return platform();
}

/**
 * Configuration interface for screenshot operations
 */
export interface ScreenshotConfig {
	screenshotPath: string;
}

/**
 * Options for screenshot optimization
 */
export interface ScreenshotOptions {
	maxWidth?: number;
	maxHeight?: number;
	quality?: number; // 1-100 for JPEG
	format?: 'png' | 'jpeg';
	returnPath?: boolean; // If true, return file path instead of base64
}

/**
 * Interface for window information
 */
export interface WindowInfo {
	id: number;
	cgWindowID: number; // Core Graphics window ID for direct capture
	title: string;
	app: string;
	position: { x: number; y: number };
	size: { width: number; height: number };
}

/**
 * Validates that the screenshot path exists and is writable
 * Creates the directory if it doesn't exist
 * @param path - The directory path to validate
 * @throws Error if the path is not writable
 */
export function validateScreenshotPath(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
	}

	// Test if directory is writable by creating a temporary file
	const testFile = join(path, ".test-write");
	try {
		writeFileSync(testFile, "");
		unlinkSync(testFile);
	} catch (error) {
		throw new Error(`Screenshot path is not writable: ${path}`);
	}
}

/**
 * Takes a screenshot and saves it to the specified directory
 * Uses platform-specific commands: screencapture (macOS), gnome-screenshot/scrot (Linux), PowerShell (Windows)
 * @param screenshotPath - Directory where the screenshot should be saved
 * @param windowId - Optional window ID to capture specific window (macOS only, uses window geometry)
 * @param options - Optional optimization settings for compression, resizing, and format
 * @returns The full path to the saved screenshot file
 * @throws Error if screenshot capture fails
 */
export function takeScreenshot(screenshotPath: string, windowId?: number, options?: ScreenshotOptions): string {
	// Set default options
	const opts: ScreenshotOptions = {
		maxWidth: 1920,
		maxHeight: 1080,
		quality: 80,
		format: 'png',
		returnPath: false,
		...options
	};

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").split("T").join("-").split(".")[0];
	const filename = `${timestamp}.${opts.format}`;
	const filepath = join(screenshotPath, filename);

	const currentPlatform = getCurrentPlatform();

	// Window-specific screenshots supported on macOS and Windows
	if (windowId && currentPlatform !== "darwin" && currentPlatform !== "win32") {
		throw new Error("Window-specific screenshots are only supported on macOS and Windows");
	}

	try {
		switch (currentPlatform) {
			case "darwin": // macOS
				if (windowId) {
					// Find the window by ID and use native window capture
					const windows = listWindows();
					const targetWindow = windows.find((w) => w.id === windowId);

					if (!targetWindow) {
						throw new Error(`Window with ID ${windowId} not found`);
					}

					// Use native utility to capture window directly by cgWindowID
					const __filename = fileURLToPath(import.meta.url);
					const __dirname = dirname(__filename);
					let captureUtilPath = join(__dirname, "native", "capture-window");

					// If the captureUtilPath doesn't exist, we might be running via tsx
					// so we need to adjust to __dirname/../dist/native/capture-window
					if (!existsSync(captureUtilPath)) {
						captureUtilPath = join(__dirname, "../dist/native", "capture-window");
					}

					execSync(`"${captureUtilPath}" ${targetWindow.cgWindowID} "${filepath}"`, { stdio: "pipe" });
				} else {
					execSync(`screencapture -x -t png "${filepath}"`, { stdio: "pipe" });
				}
				break;

			case "linux":
				// Try gnome-screenshot first, fall back to scrot
				try {
					execSync(`gnome-screenshot --file="${filepath}"`, { stdio: "pipe" });
				} catch {
					execSync(`scrot "${filepath}"`, { stdio: "pipe" });
				}
				break;

			case "win32": // Windows
				// Use PowerShell to take screenshot
				// Convert WSL paths to Windows paths if needed
				let windowsFilepath = filepath;
				if (filepath.startsWith('/mnt/')) {
					// Convert /mnt/c/path to C:\path format
					const pathParts = filepath.split('/');
					if (pathParts.length >= 3) {
						const drive = pathParts[2].toUpperCase();
						const remainingPath = pathParts.slice(3).join('\\');
						windowsFilepath = `${drive}:\\${remainingPath}`;
					}
				}

				// Prepare PowerShell script for either window-specific or full screen capture
				let psScriptContent: string;

				if (windowId) {
					// Window-specific capture for Windows
					const windows = listWindows();
					const targetWindow = windows.find((w) => w.id === windowId);

					if (!targetWindow) {
						throw new Error(`Window with ID ${windowId} not found`);
					}

					// Use the window handle (cgWindowID) to capture specific window
					psScriptContent = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;

public class WindowCapture {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
"@

$windowHandle = [IntPtr]${targetWindow.cgWindowID}

# Restore window if minimized
if ([WindowCapture]::IsIconic($windowHandle)) {
    [WindowCapture]::ShowWindow($windowHandle, 9)  # SW_RESTORE
    Start-Sleep -Milliseconds 100
}

# Get window dimensions
$rect = New-Object WindowCapture+RECT
[WindowCapture]::GetWindowRect($windowHandle, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

# Create bitmap
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()

# Capture window
[WindowCapture]::PrintWindow($windowHandle, $hdc, 0x00000002)

$graphics.ReleaseHdc($hdc)
$graphics.Dispose()

# Save image
$bitmap.Save("${windowsFilepath}", [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()`;
				} else {
					// Full screen capture
					psScriptContent = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save("${windowsFilepath}", [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()`;
				}

				// Write script to temporary file (use WSL path for writing, Windows path for PowerShell execution)
				// Fix: Use robust extension replacement to avoid "undefined" extension issue
				const lastDotIndex = filepath.lastIndexOf('.');
				const tempScriptWslPath = lastDotIndex > -1 ?
					filepath.substring(0, lastDotIndex) + '.ps1' :
					filepath + '.ps1';
				const lastDotIndexWin = windowsFilepath.lastIndexOf('.');
				const tempScriptWinPath = lastDotIndexWin > -1 ?
					windowsFilepath.substring(0, lastDotIndexWin) + '.ps1' :
					windowsFilepath + '.ps1';

				writeFileSync(tempScriptWslPath, psScriptContent);

				// Debug logging for troubleshooting
				console.error(`[DEBUG] PowerShell script path (WSL): ${tempScriptWslPath}`);
				console.error(`[DEBUG] PowerShell script path (Win): ${tempScriptWinPath}`);

				try {
					// Use full path to PowerShell when running from WSL
					const powershellPath = process.env.WSL_DISTRO_NAME ?
						"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" :
						"powershell";

					console.error(`[DEBUG] PowerShell executable: ${powershellPath}`);
					execSync(`"${powershellPath}" -ExecutionPolicy Bypass -File "${tempScriptWinPath}"`, { stdio: "pipe" });
				} catch (error) {
					// Enhanced error reporting
					console.error(`[ERROR] PowerShell execution failed: ${error instanceof Error ? error.message : String(error)}`);
					const powershellPath = process.env.WSL_DISTRO_NAME ?
						"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" :
						"powershell";
					console.error(`[ERROR] Command attempted: "${powershellPath}" -ExecutionPolicy Bypass -File "${tempScriptWinPath}"`);
					console.error(`[ERROR] Script exists (WSL path): ${existsSync(tempScriptWslPath)}`);
					throw error;
				} finally {
					// Clean up temporary script file
					try {
						unlinkSync(tempScriptWslPath);
					} catch (e) {
						// Ignore cleanup errors
					}
				}
				break;

			default:
				throw new Error(`Unsupported platform: ${currentPlatform}`);
		}

		// Verify the file was created
		if (!existsSync(filepath)) {
			throw new Error("Screenshot file was not created");
		}

		// Apply optimization if needed
		const finalPath = optimizeScreenshot(filepath, opts);

		return finalPath;
	} catch (error) {
		throw new Error(`Failed to take screenshot: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Finds and returns the path to the most recent screenshot in the directory
 * Searches for PNG files and sorts by modification time
 * @param screenshotPath - Directory to search for screenshots
 * @returns Path to the most recent screenshot, or null if none found
 * @throws Error if directory doesn't exist or cannot be read
 */
export function getLastScreenshot(screenshotPath: string): string | null {
	try {
		if (!existsSync(screenshotPath)) {
			throw new Error(`Screenshot directory does not exist: ${screenshotPath}`);
		}

		const files = readdirSync(screenshotPath)
			.filter((file) => file.endsWith(".png"))
			.map((file) => ({
				name: file,
				path: join(screenshotPath, file),
				mtime: statSync(join(screenshotPath, file)).mtime,
			}))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files.length > 0 ? files[0].path : null;
	} catch (error) {
		throw new Error(`Failed to get last screenshot: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Converts an image file to base64 encoded string
 * @param imagePath - Path to the image file to convert
 * @returns Base64 encoded string representation of the image
 * @throws Error if file cannot be read or converted
 */
export function imageToBase64(imagePath: string): string {
	try {
		const imageBuffer = readFileSync(imagePath);
		return imageBuffer.toString("base64");
	} catch (error) {
		throw new Error(`Failed to convert image to base64: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Reads configuration from environment variables
 * Uses SNAP_HAPPY_SCREENSHOT_PATH environment variable
 * Falls back to ~/Desktop/snaphappy if no environment variable is set
 * @returns Screenshot configuration object
 */
export function getScreenshotConfig(): ScreenshotConfig {
	let screenshotPath = process.env.SNAP_HAPPY_SCREENSHOT_PATH;

	if (!screenshotPath) {
		// Default to ~/Desktop/snaphappy if no environment variable is set
		const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
		screenshotPath = join(homeDir, "Desktop", "snaphappy");
	}

	return { screenshotPath };
}

/**
 * Post-processes a screenshot file to apply optimization settings
 * @param originalPath - Path to the original screenshot
 * @param options - Optimization options
 * @returns Path to the optimized screenshot
 */
function optimizeScreenshot(originalPath: string, options: ScreenshotOptions): string {
	const currentPlatform = getCurrentPlatform();

	// If no optimization needed, return original path
	if (!options.maxWidth && !options.maxHeight && options.format === 'png') {
		return originalPath;
	}

	// Generate optimized file path
	const dir = dirname(originalPath);
	const ext = options.format || 'png';
	const basename = originalPath.replace(/\.(png|jpeg)$/, '');
	const optimizedPath = `${basename}-opt.${ext}`;

	switch (currentPlatform) {
		case "win32":
			return optimizeScreenshotWindows(originalPath, optimizedPath, options);
		default:
			// For macOS/Linux, return original for now (could add ImageMagick support)
			return originalPath;
	}
}

/**
 * Optimizes screenshot on Windows using PowerShell
 */
function optimizeScreenshotWindows(originalPath: string, optimizedPath: string, options: ScreenshotOptions): string {
	try {
		// Convert paths to Windows format
		let originalWinPath = originalPath;
		let optimizedWinPath = optimizedPath;

		if (originalPath.startsWith('/mnt/')) {
			const pathParts = originalPath.split('/');
			if (pathParts.length >= 3) {
				const drive = pathParts[2].toUpperCase();
				const remainingPath = pathParts.slice(3).join('\\');
				originalWinPath = `${drive}:\\${remainingPath}`;
			}
		}

		if (optimizedPath.startsWith('/mnt/')) {
			const pathParts = optimizedPath.split('/');
			if (pathParts.length >= 3) {
				const drive = pathParts[2].toUpperCase();
				const remainingPath = pathParts.slice(3).join('\\');
				optimizedWinPath = `${drive}:\\${remainingPath}`;
			}
		}

		const powershellPath = process.env.WSL_DISTRO_NAME ?
			"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" :
			"powershell";

		const scriptParts = [
			'Add-Type -AssemblyName System.Drawing',
			`$originalImage = [System.Drawing.Image]::FromFile("${originalWinPath}")`,
			'$originalWidth = $originalImage.Width',
			'$originalHeight = $originalImage.Height',
			`$maxWidth = ${options.maxWidth || 1920}`,
			`$maxHeight = ${options.maxHeight || 1080}`,
			'',
			'if ($originalWidth -gt $maxWidth -or $originalHeight -gt $maxHeight) {',
			'    $ratioX = $maxWidth / $originalWidth',
			'    $ratioY = $maxHeight / $originalHeight',
			'    $ratio = [Math]::Min($ratioX, $ratioY)',
			'    $newWidth = [int]($originalWidth * $ratio)',
			'    $newHeight = [int]($originalHeight * $ratio)',
			'} else {',
			'    $newWidth = $originalWidth',
			'    $newHeight = $originalHeight',
			'}',
			'',
			'$resizedBitmap = New-Object System.Drawing.Bitmap $newWidth, $newHeight',
			'$graphics = [System.Drawing.Graphics]::FromImage($resizedBitmap)',
			'$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
			'$graphics.DrawImage($originalImage, 0, 0, $newWidth, $newHeight)'
		];

		if (options.format === 'jpeg') {
			scriptParts.push(
				'$encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }',
				'$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)',
				`$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, ${options.quality || 80}L)`,
				`$resizedBitmap.Save("${optimizedWinPath}", $encoder, $encoderParams)`
			);
		} else {
			scriptParts.push(`$resizedBitmap.Save("${optimizedWinPath}", [System.Drawing.Imaging.ImageFormat]::Png)`);
		}

		scriptParts.push(
			'$graphics.Dispose()',
			'$resizedBitmap.Dispose()',
			'$originalImage.Dispose()'
		);

		const psScript = scriptParts.join('\n');
		// Fix: Use robust extension replacement to avoid "undefined" extension issue
		const lastDotIndex = originalPath.lastIndexOf('.');
		const tempScriptPath = lastDotIndex > -1 ?
			originalPath.substring(0, lastDotIndex) + '-opt.ps1' :
			originalPath + '-opt.ps1';
		const lastDotIndexWin = originalWinPath.lastIndexOf('.');
		const tempScriptWinPath = lastDotIndexWin > -1 ?
			originalWinPath.substring(0, lastDotIndexWin) + '-opt.ps1' :
			originalWinPath + '-opt.ps1';

		writeFileSync(tempScriptPath, psScript);

		// Debug logging for optimization troubleshooting
		console.error(`[DEBUG] Optimization script path (WSL): ${tempScriptPath}`);
		console.error(`[DEBUG] Optimization script path (Win): ${tempScriptWinPath}`);

		try {
			execSync(`"${powershellPath}" -ExecutionPolicy Bypass -File "${tempScriptWinPath}"`, { stdio: "pipe" });

			// Clean up original and temp files
			unlinkSync(originalPath);
			unlinkSync(tempScriptPath);

			return optimizedPath;
		} catch (error) {
			// Enhanced error reporting for optimization
			console.error(`[ERROR] Screenshot optimization failed: ${error instanceof Error ? error.message : String(error)}`);
			console.error(`[ERROR] Original path: ${originalPath}, Optimized path: ${optimizedPath}`);
			// If optimization fails, clean up and return original
			try { unlinkSync(tempScriptPath); } catch (e) { /* ignore */ }
			return originalPath;
		}

	} catch (error) {
		return originalPath; // Fallback to original if optimization fails
	}
}

/**
 * Lists all visible windows using platform-specific methods
 * Returns window information including position and size
 * @returns Array of window information (id, title, app, position, size)
 * @throws Error if platform not supported or utility fails
 */
export function listWindows(): WindowInfo[] {
	const currentPlatform = getCurrentPlatform();

	switch (currentPlatform) {
		case "darwin":
			return listWindowsMacOS();
		case "win32":
			return listWindowsWindows();
		default:
			throw new Error(`Window listing is not supported on ${currentPlatform}`);
	}
}

/**
 * Lists all visible windows on macOS using native utility
 * Returns window information including position and size for use with screencapture -R
 * @returns Array of window information (id, title, app, position, size)
 * @throws Error if not on macOS or native utility fails
 */
function listWindowsMacOS(): WindowInfo[] {

	try {
		// Use the native Swift utility to get window information
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = dirname(__filename);
		let nativeUtilPath = join(__dirname, "native", "list-windows");

		// If the nativeUtilPath doesn't exist, we might be running via tsx
		// so we need to adjust to __dirname/../dist/native/list-windows
		if (!existsSync(nativeUtilPath)) {
			nativeUtilPath = join(__dirname, "../dist/native", "list-windows");
		}

		const result = execSync(nativeUtilPath, {
			encoding: "utf8",
			stdio: "pipe",
		});

		if (!result.trim()) {
			throw new Error("No windows found");
		}

		const windows: WindowInfo[] = JSON.parse(result.trim());

		if (windows.length === 0) {
			throw new Error(
				"No windows found. This may require granting Screen Recording permissions in System Preferences → Security & Privacy → Privacy → Screen Recording",
			);
		}

		return windows;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("Failed to parse window information from native utility");
		}
		throw new Error(
			`Failed to list windows: ${error instanceof Error ? error.message : String(error)}. This may require granting Screen Recording permissions in System Preferences → Security & Privacy → Privacy → Screen Recording`,
		);
	}
}

/**
 * Lists all visible windows on Windows using PowerShell
 * Returns window information including position and size
 * Uses -File approach instead of -Command for better reliability
 * @returns Array of window information (id, title, app, position, size)
 * @throws Error if PowerShell execution fails
 */
function listWindowsWindows(): WindowInfo[] {
	try {
		// Use PowerShell to get window information
		const powershellPath = process.env.WSL_DISTRO_NAME ?
			"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" :
			"powershell";

		const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
"@

$windows = @()
$processes = Get-Process | Where-Object { $_.MainWindowTitle -ne "" -and $_.MainWindowHandle -ne 0 }

foreach ($process in $processes) {
    if ([Win32]::IsWindowVisible($process.MainWindowHandle)) {
        $rect = New-Object Win32+RECT
        if ([Win32]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
            $window = @{
                id = $process.Id
                cgWindowID = $process.MainWindowHandle.ToInt64()
                title = $process.MainWindowTitle
                app = $process.ProcessName
                position = @{
                    x = $rect.Left
                    y = $rect.Top
                }
                size = @{
                    width = $rect.Right - $rect.Left
                    height = $rect.Bottom - $rect.Top
                }
            }
            $windows += $window
        }
    }
}

ConvertTo-Json $windows -Depth 3`;

		// Fix: Use Windows temp directory when running from WSL
		let tempScriptPath: string;
		let tempScriptWinPath: string;

		if (process.env.WSL_DISTRO_NAME) {
			// Use Windows temp directory when in WSL
			tempScriptPath = `/mnt/c/Windows/Temp/list-windows-${Date.now()}.ps1`;
			tempScriptWinPath = `C:\\Windows\\Temp\\list-windows-${Date.now()}.ps1`;
		} else {
			// Regular Windows path
			tempScriptPath = join(process.env.TEMP || 'C:\\Windows\\Temp', `list-windows-${Date.now()}.ps1`);
			tempScriptWinPath = tempScriptPath;
		}

		let result: string;
		try {
			writeFileSync(tempScriptPath, psScript);

			// Debug logging for window listing
			console.error(`[DEBUG] ListWindows script path (WSL): ${tempScriptPath}`);
			console.error(`[DEBUG] ListWindows script path (Win): ${tempScriptWinPath}`);

			result = execSync(`"${powershellPath}" -ExecutionPolicy Bypass -File "${tempScriptWinPath}"`, {
				encoding: "utf8",
				stdio: "pipe",
			});
		} catch (error) {
			// Enhanced error reporting for window listing
			console.error(`[ERROR] Window listing failed: ${error instanceof Error ? error.message : String(error)}`);
			console.error(`[ERROR] PowerShell path: ${powershellPath}`);
			console.error(`[ERROR] Script path: ${tempScriptWinPath}`);
			throw error;
		} finally {
			// Clean up temporary script file
			try {
				unlinkSync(tempScriptPath);
			} catch (e) {
				// Ignore cleanup errors
			}
		}

		if (!result.trim()) {
			throw new Error("No windows found");
		}

		const windows: WindowInfo[] = JSON.parse(result.trim());

		if (windows.length === 0) {
			throw new Error("No visible windows found");
		}

		return windows;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("Failed to parse window information from PowerShell");
		}
		throw new Error(
			`Failed to list windows: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}