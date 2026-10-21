//! Host checks of what does not need the network: the C functions answer
//! JSON and free it, a fresh start never wipes a folder with another name,
//! and a probe or a stop without Tor says so. Starting Tor itself is what
//! the iPhone run measures.

use super::*;

fn call(json: *mut c_char) -> Value {
    assert!(!json.is_null());
    // SAFETY: a string the library returned, freed once below.
    let text = unsafe { CStr::from_ptr(json) }.to_str().unwrap().to_owned();
    unsafe { spike_free(json) };
    serde_json::from_str(&text).unwrap()
}

#[test]
fn a_fresh_start_refuses_a_folder_with_another_name() {
    let dir = std::env::temp_dir().join("trino-spike-not-the-folder");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("keep.txt"), b"keep").unwrap();
    let path = CString::new(dir.to_str().unwrap()).unwrap();

    let answer = call(unsafe { spike_tor_start(path.as_ptr(), true, false) });

    assert_eq!(answer["ok"], json!(false));
    assert!(dir.join("keep.txt").exists(), "nothing was wiped");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_probe_and_a_stop_without_tor_say_so() {
    let probe = call(unsafe { spike_ws_probe(std::ptr::null(), 5) });
    assert_eq!(probe["ok"], json!(false));
    assert_eq!(probe["error"]["stage"], json!("probe"));

    let stop = call(spike_tor_stop());
    assert_eq!(stop["ok"], json!(false));
}

#[test]
fn notes_and_the_report_come_back_as_json() {
    let text = CString::new("background").unwrap();
    let note = call(unsafe { spike_note(text.as_ptr()) });
    assert_eq!(note["note"]["note"], json!("background"));

    let report = call(spike_report());
    assert_eq!(report["spike"], json!("trino-ios-tor"));
    assert!(report["notes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["note"] == json!("background")));
    assert!(report["memory"].is_object());

    let status = call(spike_tor_status());
    assert_eq!(status["ok"], json!(true));
}

#[test]
fn freeing_null_is_harmless() {
    unsafe { spike_free(std::ptr::null_mut()) };
}
