//! Copying without the clipboard history (cifrado local CL-6b, design §8 and
//! §12.6, test 50). Windows keeps what you copy in its clipboard history
//! (Win + V) and may send it to your other devices; the web's clipboard
//! offers no way to say no. So on Windows every copy in Trino comes here:
//! "Copiar", Ctrl + C, Ctrl + X and the text fields' own menu (the frontend
//! cancels the browser's copy and sends the text), and "Copiar imagen".
//!
//! Each copy carries, with what you copied, the marks Windows reads
//! ("Cloud Clipboard and Clipboard History Formats", learn.microsoft.com,
//! dataxchg/clipboard-formats):
//!
//! - `CanIncludeInClipboardHistory` = 0: not into the clipboard history;
//! - `CanUploadToCloudClipboard` = 0: not to your other devices;
//! - `ExcludeClipboardContentFromMonitorProcessing`: the one the clipboard
//!   managers of other programs read to leave it alone. The design names the
//!   first two; this third one is added because it is the mark those
//!   programs know, and some still ignore it (the texts say so).
//!
//! The marks go in before what you copied, so nothing is ever on the
//! clipboard without them; if anything fails, the clipboard is emptied.
//!
//! What goes on the clipboard is a pure function (`text_items`,
//! `image_items`), tested on every system; the Win32 calls are thin and
//! tested on Windows against the real clipboard.

/// A clipboard format: one of the system's by number, or one registered by
/// name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Format {
    Standard(u32),
    Registered(&'static str),
}

/// UTF-16 text (WinUser.h).
pub(crate) const CF_UNICODETEXT: u32 = 13;
/// A picture with a `BITMAPV5HEADER`, which carries its alpha (WinUser.h).
pub(crate) const CF_DIBV5: u32 = 17;

/// Not into the clipboard history: a DWORD 0.
pub(crate) const NO_HISTORY: &str = "CanIncludeInClipboardHistory";
/// Not to the cloud clipboard: a DWORD 0.
pub(crate) const NO_CLOUD: &str = "CanUploadToCloudClipboard";
/// Clipboard managers leave it alone: any data.
pub(crate) const NO_MONITORS: &str = "ExcludeClipboardContentFromMonitorProcessing";
/// The PNG itself, as browsers and image editors read it.
pub(crate) const PNG: &str = "PNG";

/// The most a picture may have, so a copy never asks for gigabytes.
pub(crate) const MAX_IMAGE_PIXELS: u64 = 64 * 1024 * 1024;

/// One format and its bytes, as they go on the clipboard.
pub(crate) type Item = (Format, Vec<u8>);

/// The marks every copy carries, first.
pub(crate) fn privacy_marks() -> Vec<Item> {
    vec![
        (Format::Registered(NO_MONITORS), vec![0]),
        (Format::Registered(NO_HISTORY), 0u32.to_le_bytes().to_vec()),
        (Format::Registered(NO_CLOUD), 0u32.to_le_bytes().to_vec()),
    ]
}

/// What copying `text` puts on the clipboard: the marks, then the text as
/// UTF-16 ending in NUL.
pub(crate) fn text_items(text: &str) -> Vec<Item> {
    let utf16 = text
        .encode_utf16()
        .chain([0])
        .flat_map(u16::to_le_bytes)
        .collect();
    let mut items = privacy_marks();
    items.push((Format::Standard(CF_UNICODETEXT), utf16));
    items
}

/// What copying a picture puts on the clipboard: the marks, the PNG itself,
/// and the picture as a DIB for the programs that read only that.
pub(crate) fn image_items(png: &[u8], width: u32, height: u32, rgba: &[u8]) -> Vec<Item> {
    let mut items = privacy_marks();
    items.push((Format::Registered(PNG), png.to_vec()));
    items.push((Format::Standard(CF_DIBV5), dibv5(width, height, rgba)));
    items
}

/// A `CF_DIBV5`: a `BITMAPV5HEADER` (124 bytes, 32 bits, BI_BITFIELDS with
/// the masks of BGRA, sRGB) and the rows from the bottom up, as BGRA. The
/// caller checks the size first (`image_fits`).
pub(crate) fn dibv5(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    const HEADER: u32 = 124;
    const BI_BITFIELDS: u32 = 3;
    const LCS_SRGB: u32 = 0x7352_4742;
    const LCS_GM_IMAGES: u32 = 4;
    let row = width as usize * 4;
    let size = row * height as usize;
    let mut dib = Vec::with_capacity(HEADER as usize + size);
    dib.extend_from_slice(&HEADER.to_le_bytes());
    dib.extend_from_slice(&(width as i32).to_le_bytes());
    dib.extend_from_slice(&(height as i32).to_le_bytes());
    dib.extend_from_slice(&1u16.to_le_bytes()); // planes
    dib.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    dib.extend_from_slice(&BI_BITFIELDS.to_le_bytes());
    dib.extend_from_slice(&(size as u32).to_le_bytes());
    dib.extend_from_slice(&[0; 16]); // resolution, colours used and important
    for mask in [0x00FF_0000u32, 0x0000_FF00, 0x0000_00FF, 0xFF00_0000] {
        dib.extend_from_slice(&mask.to_le_bytes());
    }
    dib.extend_from_slice(&LCS_SRGB.to_le_bytes());
    dib.extend_from_slice(&[0; 48]); // endpoints and gamma
    dib.extend_from_slice(&LCS_GM_IMAGES.to_le_bytes());
    dib.extend_from_slice(&[0; 12]); // profile data, profile size, reserved
    debug_assert_eq!(dib.len(), HEADER as usize);
    if row > 0 {
        for line in rgba[..size].chunks_exact(row).rev() {
            for [r, g, b, a] in line.as_chunks::<4>().0 {
                dib.extend_from_slice(&[*b, *g, *r, *a]);
            }
        }
    }
    dib
}

/// Whether a picture of this size can be copied.
pub(crate) fn image_fits(width: u32, height: u32, rgba_len: usize) -> bool {
    let pixels = u64::from(width) * u64::from(height);
    pixels > 0 && pixels <= MAX_IMAGE_PIXELS && rgba_len as u64 >= pixels * 4
}

/// Puts `items` on the clipboard, in that order, and returns the
/// clipboard's count of changes after it.
#[cfg(windows)]
pub(crate) fn write(items: &[Item]) -> Result<u32, String> {
    win::write(items)
}

/// Off Windows, the webview's own clipboard is used: nothing comes here.
#[cfg(not(windows))]
pub(crate) fn write(_items: &[Item]) -> Result<u32, String> {
    Err("copying through the backend is only for Windows".into())
}

#[cfg(windows)]
mod win {
    use super::{Format, Item};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{GlobalFree, HANDLE};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard,
        RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    /// The clipboard, open on this thread until dropped.
    pub(super) struct Open;

    impl Open {
        /// Another program may hold the clipboard for a moment: try for
        /// about half a second.
        pub(super) fn new() -> Result<Open, String> {
            for _ in 0..25 {
                // SAFETY: no pointer is passed; the clipboard stays tied to
                // this thread until `CloseClipboard` in `drop`.
                if unsafe { OpenClipboard(None) }.is_ok() {
                    return Ok(Open);
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err("the clipboard is busy".into())
        }
    }

    impl Drop for Open {
        fn drop(&mut self) {
            // SAFETY: this thread opened the clipboard in `Open::new`.
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    fn format_id(format: &Format) -> Result<u32, String> {
        match format {
            Format::Standard(id) => Ok(*id),
            Format::Registered(name) => {
                let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
                // SAFETY: `wide` ends in NUL and outlives the call.
                match unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) } {
                    0 => Err(format!(
                        "the clipboard format {name} could not be registered"
                    )),
                    id => Ok(id),
                }
            }
        }
    }

    /// Hands `bytes` to the clipboard under `format`; the clipboard owns
    /// them after.
    fn put(format: &Format, bytes: &[u8]) -> Result<(), String> {
        let id = format_id(format)?;
        // SAFETY: the block is allocated with room for `bytes`, written
        // while locked, and freed here unless the clipboard took it.
        unsafe {
            let memory =
                GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).map_err(|e| e.to_string())?;
            let data = GlobalLock(memory);
            if data.is_null() {
                let _ = GlobalFree(Some(memory));
                return Err("the clipboard's memory could not be locked".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), data.cast::<u8>(), bytes.len());
            let _ = GlobalUnlock(memory);
            if let Err(e) = SetClipboardData(id, Some(HANDLE(memory.0))) {
                let _ = GlobalFree(Some(memory));
                return Err(e.to_string());
            }
        }
        Ok(())
    }

    pub(super) fn write(items: &[Item]) -> Result<u32, String> {
        let open = Open::new()?;
        // SAFETY: the clipboard is open on this thread.
        unsafe { EmptyClipboard() }.map_err(|e| e.to_string())?;
        if let Err(e) = items
            .iter()
            .try_for_each(|(format, bytes)| put(format, bytes))
        {
            // Never part of a copy, nor what you copied without its marks.
            // SAFETY: the clipboard is still open on this thread.
            unsafe {
                let _ = EmptyClipboard();
            }
            return Err(e);
        }
        drop(open);
        // SAFETY: no arguments.
        Ok(unsafe { GetClipboardSequenceNumber() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dword(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    #[cfg(windows)]
    fn prefix(bytes: &Option<Vec<u8>>, len: usize) -> Option<&[u8]> {
        bytes.as_deref().and_then(|bytes| bytes.get(..len))
    }

    #[test]
    fn every_copy_starts_with_the_history_cloud_and_monitor_marks() {
        let marks = privacy_marks();
        assert_eq!(
            marks,
            vec![
                (Format::Registered(NO_MONITORS), vec![0]),
                (Format::Registered(NO_HISTORY), vec![0, 0, 0, 0]),
                (Format::Registered(NO_CLOUD), vec![0, 0, 0, 0]),
            ]
        );
        for items in [text_items("hola"), image_items(b"png", 1, 1, &[1, 2, 3, 4])] {
            assert_eq!(&items[..3], &marks[..], "the marks go first");
        }
    }

    #[test]
    fn text_goes_as_utf16_ending_in_nul() {
        let items = text_items("Ñandú ☕");
        assert_eq!(items.len(), 4);
        let (format, bytes) = &items[3];
        assert_eq!(format, &Format::Standard(CF_UNICODETEXT));
        let expected: Vec<u8> = "Ñandú ☕"
            .encode_utf16()
            .chain([0])
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(bytes, &expected);
        assert_eq!(text_items("")[3].1, vec![0, 0], "an empty text is its NUL");
    }

    #[test]
    fn a_picture_goes_as_png_and_as_a_dibv5() {
        let rgba = [10, 20, 30, 255, 40, 50, 60, 128];
        let items = image_items(b"\x89PNG..", 2, 1, &rgba);
        assert_eq!(items.len(), 5);
        assert_eq!(items[3], (Format::Registered(PNG), b"\x89PNG..".to_vec()));
        assert_eq!(items[4], (Format::Standard(CF_DIBV5), dibv5(2, 1, &rgba)));
    }

    #[test]
    fn a_dibv5_has_its_header_and_rows_from_the_bottom_in_bgra() {
        // Two rows of one pixel: red on top, blue at the bottom.
        let rgba = [255, 0, 0, 255, 0, 0, 255, 200];
        let dib = dibv5(1, 2, &rgba);
        assert_eq!(dib.len(), 124 + 8);
        assert_eq!(dword(&dib, 0), 124, "bV5Size");
        assert_eq!(dword(&dib, 4), 1, "bV5Width");
        assert_eq!(dword(&dib, 8), 2, "bV5Height, positive: bottom-up");
        assert_eq!(u16::from_le_bytes([dib[12], dib[13]]), 1, "bV5Planes");
        assert_eq!(u16::from_le_bytes([dib[14], dib[15]]), 32, "bV5BitCount");
        assert_eq!(dword(&dib, 16), 3, "BI_BITFIELDS");
        assert_eq!(dword(&dib, 20), 8, "bV5SizeImage");
        assert_eq!(dword(&dib, 40), 0x00FF_0000, "red mask");
        assert_eq!(dword(&dib, 44), 0x0000_FF00, "green mask");
        assert_eq!(dword(&dib, 48), 0x0000_00FF, "blue mask");
        assert_eq!(dword(&dib, 52), 0xFF00_0000, "alpha mask");
        assert_eq!(dword(&dib, 56), 0x7352_4742, "LCS_sRGB");
        assert_eq!(dword(&dib, 108), 4, "LCS_GM_IMAGES");
        // The bottom row (blue) first, then the top one (red), as BGRA.
        assert_eq!(&dib[124..], &[255, 0, 0, 200, 0, 0, 255, 255]);
    }

    #[test]
    fn a_picture_too_big_or_short_of_pixels_does_not_fit() {
        assert!(image_fits(2, 2, 16));
        assert!(!image_fits(2, 2, 15), "fewer bytes than pixels");
        assert!(!image_fits(0, 2, 0), "no width");
        assert!(
            !image_fits(1 << 14, 1 << 14, (1usize << 28) * 4),
            "too many pixels"
        );
    }

    /// Design §12.6, test 50: the real clipboard on Windows. It replaces
    /// what the clipboard holds with a test text, and empties it after.
    #[cfg(windows)]
    #[test]
    fn copied_text_carries_the_history_and_cloud_marks() {
        let _clipboard = win_tests::exclusive();
        write(&text_items("trino: prueba del portapapeles")).unwrap();
        let read = win_tests::read_all(&[
            Format::Registered(NO_HISTORY),
            Format::Registered(NO_CLOUD),
            Format::Registered(NO_MONITORS),
            Format::Standard(CF_UNICODETEXT),
        ]);
        win_tests::empty();
        // Windows may hand back a block larger than the one written.
        assert_eq!(prefix(&read[0], 4), Some(&[0u8, 0, 0, 0][..]));
        assert_eq!(prefix(&read[1], 4), Some(&[0u8, 0, 0, 0][..]));
        assert!(read[2].is_some());
        let text: Vec<u16> = read[3]
            .as_ref()
            .unwrap()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .take_while(|&unit| unit != 0)
            .collect();
        assert_eq!(
            String::from_utf16(&text).unwrap(),
            "trino: prueba del portapapeles"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_copied_picture_carries_the_marks_its_png_and_its_dib() {
        let _clipboard = win_tests::exclusive();
        let rgba = [1, 2, 3, 255];
        write(&image_items(b"\x89PNG-test", 1, 1, &rgba)).unwrap();
        let read = win_tests::read_all(&[
            Format::Registered(NO_HISTORY),
            Format::Registered(NO_CLOUD),
            Format::Registered(PNG),
            Format::Standard(CF_DIBV5),
        ]);
        win_tests::empty();
        assert_eq!(prefix(&read[0], 4), Some(&[0u8, 0, 0, 0][..]));
        assert_eq!(prefix(&read[1], 4), Some(&[0u8, 0, 0, 0][..]));
        assert_eq!(prefix(&read[2], 9), Some(&b"\x89PNG-test"[..]));
        // Windows may add its own fields to a DIB it reads back; the header
        // and the pixel are the ones written.
        let dib = read[3].as_ref().unwrap();
        assert_eq!(dword(dib, 0), 124);
        assert_eq!(&dib[124..128], &[3, 2, 1, 255]);
    }

    /// The real clipboard, one test at a time.
    #[cfg(windows)]
    pub(crate) mod win_tests {
        use super::super::*;
        use std::sync::{Mutex, MutexGuard, PoisonError};
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HGLOBAL;
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard,
            RegisterClipboardFormatW,
        };
        use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

        static CLIPBOARD: Mutex<()> = Mutex::new(());

        pub(crate) fn exclusive() -> MutexGuard<'static, ()> {
            CLIPBOARD.lock().unwrap_or_else(PoisonError::into_inner)
        }

        fn open() {
            for _ in 0..50 {
                if unsafe { OpenClipboard(None) }.is_ok() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            panic!("the clipboard could not be opened");
        }

        fn id(format: &Format) -> u32 {
            match format {
                Format::Standard(id) => *id,
                Format::Registered(name) => {
                    let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
                    unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) }
                }
            }
        }

        /// The bytes of each format, or None where the clipboard has none.
        pub(crate) fn read_all(formats: &[Format]) -> Vec<Option<Vec<u8>>> {
            open();
            let read = formats
                .iter()
                .map(|format| unsafe {
                    let handle = GetClipboardData(id(format)).ok()?;
                    let memory = HGLOBAL(handle.0);
                    let size = GlobalSize(memory);
                    let data = GlobalLock(memory);
                    if data.is_null() {
                        return None;
                    }
                    let bytes = std::slice::from_raw_parts(data as *const u8, size).to_vec();
                    let _ = GlobalUnlock(memory);
                    Some(bytes)
                })
                .collect();
            unsafe {
                let _ = CloseClipboard();
            }
            read
        }

        pub(crate) fn empty() {
            open();
            unsafe {
                let _ = EmptyClipboard();
                let _ = CloseClipboard();
            }
        }
    }
}
