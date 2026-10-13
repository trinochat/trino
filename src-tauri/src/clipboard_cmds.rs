//! The commands of copying without the clipboard history (cifrado local
//! CL-6b, design §8): on Windows the frontend sends here every text you
//! copy ("Copiar", Ctrl + C, Ctrl + X and the text fields' menu) and every
//! picture ("Copiar imagen"); `crate::clipboard` puts them on the clipboard
//! with the marks that keep them out of the clipboard history and the
//! cloud. Off Windows they refuse, and the frontend uses the webview's own
//! clipboard.
//!
//! A child module of `commands`, so it reaches the session's preferences.

use crate::clipboard::{self, Item};
use base64::Engine;

/// The most text one copy takes, in bytes of UTF-8.
pub(crate) const MAX_TEXT: usize = 16 * 1024 * 1024;
/// What every PNG starts with.
const PNG_SIGNATURE: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
/// The most PNG one copy takes, in bytes, before base64.
pub(crate) const MAX_PNG: usize = 48 * 1024 * 1024;

/// What copying `text` puts on the clipboard, or why it cannot.
pub(crate) fn text_copy(text: &str) -> Result<Vec<Item>, String> {
    if text.len() > MAX_TEXT {
        return Err("the text is too long to copy".into());
    }
    Ok(clipboard::text_items(text))
}

/// What copying the PNG in `png_base64` puts on the clipboard, or why it
/// cannot: the PNG as it came, and its pixels for the programs that read a
/// DIB.
pub(crate) fn image_copy(png_base64: &str) -> Result<Vec<Item>, String> {
    if png_base64.len() > MAX_PNG / 3 * 4 + 4 {
        return Err("the picture is too big to copy".into());
    }
    let png = base64::engine::general_purpose::STANDARD
        .decode(png_base64)
        .map_err(|_| "the picture is not in base64".to_string())?;
    if !png.starts_with(PNG_SIGNATURE) {
        return Err("the picture is not a PNG".into());
    }
    let image = tauri::image::Image::from_bytes(&png).map_err(|e| e.to_string())?;
    let (width, height, rgba) = (image.width(), image.height(), image.rgba());
    if !clipboard::image_fits(width, height, rgba.len()) {
        return Err("the picture is too big to copy".into());
    }
    Ok(clipboard::image_items(&png, width, height, rgba))
}

/// Puts `items` on the clipboard, away from the async runtime: opening the
/// clipboard may wait for another program.
async fn put(items: Vec<Item>) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || clipboard::write(&items))
        .await
        .map_err(|e| e.to_string())?
}

/// Copies a text without the clipboard history (Windows only).
#[tauri::command]
pub async fn clipboard_write_text(text: String) -> Result<(), String> {
    put(text_copy(&text)?).await.map(drop)
}

/// Copies a picture, given as a PNG in base64, without the clipboard
/// history (Windows only).
#[tauri::command]
pub async fn clipboard_write_image(png: String) -> Result<(), String> {
    put(image_copy(&png)?).await.map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::{Format, CF_DIBV5, CF_UNICODETEXT, PNG};

    /// A PNG of one pixel.
    const ONE_PIXEL: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    #[test]
    fn a_text_copies_with_its_marks() {
        let items = text_copy("hola").unwrap();
        assert_eq!(items, clipboard::text_items("hola"));
        assert_eq!(items[3].0, Format::Standard(CF_UNICODETEXT));
    }

    #[test]
    fn a_text_too_long_is_refused() {
        assert!(text_copy(&"a".repeat(MAX_TEXT)).is_ok());
        assert!(text_copy(&"a".repeat(MAX_TEXT + 1)).is_err());
    }

    #[test]
    fn a_png_copies_as_itself_and_as_a_dib() {
        let items = image_copy(ONE_PIXEL).unwrap();
        let png = base64::engine::general_purpose::STANDARD
            .decode(ONE_PIXEL)
            .unwrap();
        assert_eq!(&items[..3], &clipboard::privacy_marks()[..]);
        assert_eq!(items[3], (Format::Registered(PNG), png));
        let (format, dib) = &items[4];
        assert_eq!(format, &Format::Standard(CF_DIBV5));
        assert_eq!(dib.len(), 124 + 4, "one pixel after the header");
        assert_eq!(&dib[4..12], &[1, 0, 0, 0, 1, 0, 0, 0], "1 x 1");
    }

    #[test]
    fn what_is_not_a_png_in_base64_is_refused() {
        assert!(image_copy("not base64!").is_err());
        let gif = base64::engine::general_purpose::STANDARD.encode(b"GIF89a....");
        assert!(image_copy(&gif).is_err());
        assert!(image_copy("").is_err());
    }
}
