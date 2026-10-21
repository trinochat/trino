//! How much memory the process uses, as iOS counts it.
//!
//! On iOS the number that matters is `phys_footprint` (what Xcode's memory
//! gauge shows and what the system kills an app for), from
//! `task_info(TASK_VM_INFO)`. `os_proc_available_memory` says how much is
//! left before that limit. Elsewhere, the peak resident size from
//! `getrusage`, so the host build answers something too.

use serde_json::{json, Value};

#[cfg_attr(not(unix), allow(dead_code))]
const MB: f64 = 1024.0 * 1024.0;

#[cfg_attr(not(unix), allow(dead_code))]
fn mb(bytes: u64) -> f64 {
    (bytes as f64 / MB * 10.0).round() / 10.0
}

/// The memory now, in MB.
pub fn snapshot() -> Value {
    #[allow(unused_mut)] // Nothing to add on Windows.
    let mut out = json!({});
    #[cfg(target_vendor = "apple")]
    if let Some(info) = apple::vm_info() {
        // Copied out of the packed struct before use.
        let footprint = info.phys_footprint;
        let resident = info.resident_size;
        let resident_peak = info.resident_size_peak;
        out["physFootprintMb"] = json!(mb(footprint));
        out["residentMb"] = json!(mb(resident));
        out["residentPeakMb"] = json!(mb(resident_peak));
    }
    #[cfg(target_os = "ios")]
    {
        out["availableMb"] = json!(mb(apple::available()));
    }
    #[cfg(unix)]
    if let Some(peak) = unix::max_rss_bytes() {
        out["maxRssMb"] = json!(mb(peak));
    }
    out
}

#[cfg(target_vendor = "apple")]
mod apple {
    /// The start of `task_vm_info_data_t` (<mach/task_info.h>), through
    /// `phys_footprint`: the fields of TASK_VM_INFO_REV1. The header packs
    /// it to 4 bytes.
    #[repr(C, packed(4))]
    #[derive(Default)]
    pub struct TaskVmInfo {
        pub virtual_size: u64,
        pub region_count: i32,
        pub page_size: i32,
        pub resident_size: u64,
        pub resident_size_peak: u64,
        pub device: u64,
        pub device_peak: u64,
        pub internal: u64,
        pub internal_peak: u64,
        pub external: u64,
        pub external_peak: u64,
        pub reusable: u64,
        pub reusable_peak: u64,
        pub purgeable_volatile_pmap: u64,
        pub purgeable_volatile_resident: u64,
        pub purgeable_volatile_virtual: u64,
        pub compressed: u64,
        pub compressed_peak: u64,
        pub compressed_lifetime: u64,
        pub phys_footprint: u64,
    }

    // TASK_VM_INFO_REV1_COUNT is 38 natural_t: 152 bytes.
    const _: () = assert!(std::mem::size_of::<TaskVmInfo>() == 152);

    const TASK_VM_INFO: u32 = 22;
    const KERN_SUCCESS: i32 = 0;

    extern "C" {
        static mach_task_self_: u32;
        fn task_info(task: u32, flavor: u32, info: *mut i32, count: *mut u32) -> i32;
    }

    #[cfg(target_os = "ios")]
    extern "C" {
        // <os/proc.h>, iOS 13 and later.
        fn os_proc_available_memory() -> usize;
    }

    pub fn vm_info() -> Option<TaskVmInfo> {
        let mut info = TaskVmInfo::default();
        let mut count = (std::mem::size_of::<TaskVmInfo>() / 4) as u32;
        // SAFETY: `info` is as large as `count` says, in 4-byte units, and
        // task_info writes at most that much.
        let done = unsafe {
            task_info(
                mach_task_self_,
                TASK_VM_INFO,
                std::ptr::addr_of_mut!(info).cast::<i32>(),
                &mut count,
            )
        };
        (done == KERN_SUCCESS).then_some(info)
    }

    #[cfg(target_os = "ios")]
    pub fn available() -> u64 {
        // SAFETY: no arguments, no state.
        unsafe { os_proc_available_memory() as u64 }
    }
}

#[cfg(unix)]
mod unix {
    pub fn max_rss_bytes() -> Option<u64> {
        // SAFETY: getrusage fills the struct it is given.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
            return None;
        }
        let peak = u64::try_from(usage.ru_maxrss).ok()?;
        // Bytes on Apple's systems, kilobytes elsewhere.
        Some(if cfg!(target_vendor = "apple") {
            peak
        } else {
            peak * 1024
        })
    }
}
