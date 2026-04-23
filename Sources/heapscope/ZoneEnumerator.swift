import Foundation
import HeapScopeC

struct Allocation {
    let address: UInt64
    let size: UInt64
    let zoneIndex: Int
}

struct ZoneSnapshot {
    /// Sorted ascending by address. Binary search in `GraphBuilder` depends on this.
    let allocations: [Allocation]
    let zoneNames: [String]
}

/// Cross-task enumerate every live allocation in every registered malloc zone of
/// the target. The heavy lifting (reading zone structs, stripping PAC off the
/// enumerator function pointer, calling it with our `memory_reader_t` +
/// `vm_range_recorder_t` callbacks) lives in HeapScopeC — this wraps the result
/// into Swift-native types.
func enumerateZones(task: TargetTask) throws -> ZoneSnapshot {
    var allocsPtr: UnsafeMutablePointer<hs_allocation_t>? = nil
    var count: size_t = 0
    var namesPtr: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>? = nil
    var zoneCount: size_t = 0

    let kr = hs_enumerate_allocations(task.port,
                                      &allocsPtr, &count,
                                      &namesPtr, &zoneCount)
    guard kr == KERN_SUCCESS else {
        throw HeapScopeError.enumerationFailed(kr: kr)
    }
    defer {
        if allocsPtr != nil { hs_free(allocsPtr) }
        if namesPtr != nil { hs_free_strings(namesPtr, zoneCount) }
    }

    var allocs: [Allocation] = []
    allocs.reserveCapacity(count)
    if let base = allocsPtr {
        for i in 0..<count {
            let a = base[i]
            allocs.append(Allocation(address: a.address,
                                     size: a.size,
                                     zoneIndex: Int(a.zone_index)))
        }
    }
    allocs.sort { $0.address < $1.address }

    var names: [String] = []
    names.reserveCapacity(zoneCount)
    if let b = namesPtr {
        for i in 0..<zoneCount {
            names.append(b[i].map { String(cString: $0) } ?? "zone")
        }
    }

    return ZoneSnapshot(allocations: allocs, zoneNames: names)
}
