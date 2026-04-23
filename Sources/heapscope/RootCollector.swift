import Foundation
import HeapScopeC

struct RootRegions {
    /// `__DATA*` segments of every loaded image.
    let dataRanges: [hs_range_t]
    /// 512KB window from each thread's `__sp` upward. Stack grows down on arm64.
    let stackRanges: [hs_range_t]
    /// x0..x28, fp, lr for every thread, flattened. Treated as candidate pointers.
    let registerWords: [UInt64]
}

func collectRoots(task: TargetTask) -> RootRegions {
    let data = machODataRanges(task: task)

    var stackPtr: UnsafeMutablePointer<hs_range_t>? = nil
    var stackCount: size_t = 0
    var regsPtr: UnsafeMutablePointer<UInt64>? = nil
    var regsCount: size_t = 0

    let kr = hs_collect_thread_roots(task.port,
                                     &stackPtr, &stackCount,
                                     &regsPtr, &regsCount)
    if kr != KERN_SUCCESS {
        FileHandle.standardError.write(Data(
            "heapscope: warning — thread root collection failed (kr=\(kr))\n".utf8))
        return RootRegions(dataRanges: data, stackRanges: [], registerWords: [])
    }
    defer {
        if stackPtr != nil { hs_free(stackPtr) }
        if regsPtr != nil  { hs_free(regsPtr) }
    }

    var stacks: [hs_range_t] = []
    stacks.reserveCapacity(stackCount)
    if let b = stackPtr {
        for i in 0..<stackCount { stacks.append(b[i]) }
    }

    var regs: [UInt64] = []
    regs.reserveCapacity(regsCount)
    if let b = regsPtr {
        for i in 0..<regsCount { regs.append(b[i]) }
    }

    return RootRegions(dataRanges: data, stackRanges: stacks, registerWords: regs)
}
