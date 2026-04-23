import Foundation
import HeapScopeC

struct Graph {
    let allocations: [Allocation]
    var reachable: [Bool]
    /// `edges[i]` is the set of allocation indices reachable via a pointer stored
    /// inside allocation `i`'s bytes. Populated for **every** allocation, not just
    /// reachable ones — otherwise Tarjan would see an empty subgraph over leaks.
    var edges: [[Int]]
}

/// Binary search for the allocation whose `[address, address+size)` range contains
/// `addr`. Requires `allocs` sorted ascending by address.
@inline(__always)
func lookupAllocation(_ allocs: [Allocation], _ addr: UInt64) -> Int? {
    var lo = 0
    var hi = allocs.count
    while lo < hi {
        let mid = (lo &+ hi) >> 1
        if allocs[mid].address <= addr { lo = mid + 1 } else { hi = mid }
    }
    let idx = lo - 1
    if idx < 0 { return nil }
    let a = allocs[idx]
    return (addr < a.address &+ a.size) ? idx : nil
}

/// Build the reachability graph in three explicit phases:
///
/// 1. **Edge discovery.** Scan every allocation's bytes and record every outgoing
///    allocation→allocation edge. This MUST cover leaked blocks too, because
///    cycle detection runs on the leaked subgraph and needs their edges.
/// 2. **Seed from roots.** Mark allocations directly referenced by thread
///    registers, thread-stack words, or `__DATA` segment words as reachable.
/// 3. **BFS propagate.** Walk the recorded edge graph from the reachable seed.
///
/// Conservative scanning (any 8-byte word that lands inside a live block is
/// a pointer) matches the `Leaks`(1) model and biases toward false negatives
/// rather than falsely accusing live objects.
func buildReachability(task: TargetTask,
                       snapshot: ZoneSnapshot,
                       roots: RootRegions) -> Graph {
    let allocs = snapshot.allocations
    var reachable = Array(repeating: false, count: allocs.count)
    var edgeSets = Array(repeating: Set<Int>(), count: allocs.count)

    // Phase 1: scan every allocation's bytes.
    for from in 0..<allocs.count {
        let a = allocs[from]
        scanWords(task: task, address: a.address, size: a.size) { raw in
            if raw == 0 { return }
            let cand = stripPAC(raw)
            guard let to = lookupAllocation(allocs, cand) else { return }
            // Skip self-hits that aren't the block's base — those are almost
            // always refcount/padding bits that happen to overlap the block's
            // own range, not a genuine self-reference.
            if to == from && cand != allocs[from].address { return }
            edgeSets[from].insert(to)
        }
    }

    // Phase 2: seed reachability from roots.
    var queue: [Int] = []
    queue.reserveCapacity(allocs.count)

    for word in roots.registerWords {
        let addr = stripPAC(word)
        if let idx = lookupAllocation(allocs, addr), !reachable[idx] {
            reachable[idx] = true
            queue.append(idx)
        }
    }
    for range in roots.dataRanges {
        seedFromRoot(task: task, address: range.address, size: range.size,
                     allocs: allocs, reachable: &reachable, queue: &queue)
    }
    for range in roots.stackRanges {
        seedFromRoot(task: task, address: range.address, size: range.size,
                     allocs: allocs, reachable: &reachable, queue: &queue)
    }

    // Phase 3: BFS propagate along the edge graph.
    var head = 0
    while head < queue.count {
        let from = queue[head]; head += 1
        for to in edgeSets[from] where !reachable[to] {
            reachable[to] = true
            queue.append(to)
        }
    }

    let edges = edgeSets.map { Array($0).sorted() }
    return Graph(allocations: allocs, reachable: reachable, edges: edges)
}

/// Walk a target region word-by-word at 8-byte stride. We try one big read first;
/// on failure, fall back to per-4KB-page reads so a single unmapped page in a
/// shared-cache `__DATA_CONST` region doesn't nuke the whole segment scan.
/// Unreadable pages are skipped silently — expected, not exceptional.
private func scanWords(task: TargetTask,
                       address: UInt64, size: UInt64,
                       _ onWord: (UInt64) -> Void) {
    if size < 8 { return }

    // Fast path: read the whole region in one syscall.
    var buf: UnsafeMutableRawPointer? = nil
    if hs_read_memory(task.port, address, Int(size), &buf) == KERN_SUCCESS,
       let b = buf {
        defer { hs_free(b) }
        let words = Int(size) / MemoryLayout<UInt64>.size
        let p = b.assumingMemoryBound(to: UInt64.self)
        for i in 0..<words { onWord(p[i]) }
        return
    }

    // Slow path: chunk by page. Each chunk starts at `addr` and ends at the
    // next page boundary or the region's end, whichever comes first.
    let pageSize: UInt64 = 4096
    let pageMask: UInt64 = ~(pageSize &- 1)
    let end = address &+ size
    var addr = address
    while addr < end {
        let nextPage = (addr &+ pageSize) & pageMask
        let limit = min(nextPage, end)
        let chunk = limit - addr
        if chunk >= 8 {
            var cb: UnsafeMutableRawPointer? = nil
            if hs_read_memory(task.port, addr, Int(chunk), &cb) == KERN_SUCCESS,
               let cbb = cb {
                let words = Int(chunk) / MemoryLayout<UInt64>.size
                let p = cbb.assumingMemoryBound(to: UInt64.self)
                for i in 0..<words { onWord(p[i]) }
                hs_free(cbb)
            }
        }
        addr = limit
    }
}

private func seedFromRoot(task: TargetTask,
                          address: UInt64, size: UInt64,
                          allocs: [Allocation],
                          reachable: inout [Bool],
                          queue: inout [Int]) {
    scanWords(task: task, address: address, size: size) { raw in
        if raw == 0 { return }
        let cand = stripPAC(raw)
        if let to = lookupAllocation(allocs, cand), !reachable[to] {
            reachable[to] = true
            queue.append(to)
        }
    }
}
