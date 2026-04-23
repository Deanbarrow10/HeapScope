import Foundation
import HeapScopeC

/// Returns every `__DATA` / `__DATA_CONST` / `__DATA_DIRTY` segment of every image
/// currently loaded in the target, expressed as `(address, size)` in the target's
/// virtual address space. These are the primary root regions for conservative
/// pointer scanning: globals, static class references, objc metadata, dyld's
/// own bookkeeping, and everything in between lives here.
///
/// The walk uses `task_info(TASK_DYLD_INFO)` to get the target's
/// `all_image_infos_addr`, then reads the image array and each image's Mach-O
/// load commands via `mach_vm_read` (done in HeapScopeC). On failure we emit a
/// warning and return `[]` rather than aborting — the analyzer can still find
/// cycle-based leaks from thread roots alone.
func machODataRanges(task: TargetTask) -> [hs_range_t] {
    var rangesPtr: UnsafeMutablePointer<hs_range_t>? = nil
    var count: size_t = 0
    let kr = hs_collect_data_ranges(task.port, &rangesPtr, &count)
    guard kr == KERN_SUCCESS else {
        FileHandle.standardError.write(Data(
            "heapscope: warning — dyld image walk failed (kr=\(kr)); continuing without __DATA roots\n".utf8))
        return []
    }
    defer { if rangesPtr != nil { hs_free(rangesPtr) } }

    var out: [hs_range_t] = []
    out.reserveCapacity(count)
    if let b = rangesPtr {
        for i in 0..<count { out.append(b[i]) }
    }
    return out
}
