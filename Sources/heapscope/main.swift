import Foundation
import HeapScopeC
import Darwin

let args = CommandLine.arguments
guard args.count >= 2, let pid = Int32(args[1]) else {
    FileHandle.standardError.write(Data("usage: sudo heapscope <pid> [--output path.json]\n".utf8))
    exit(2)
}
var outputPath = "leaks.json"
if let idx = args.firstIndex(of: "--output"), idx + 1 < args.count {
    outputPath = args[idx + 1]
}

func eprint(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}

do {
    let target = try TargetTask.attach(pid: pid)
    try target.suspend()
    defer { target.resume() }

    eprint("heapscope: attached to pid \(pid); enumerating zones…")
    let snapshot = try enumerateZones(task: target)
    eprint("heapscope: \(snapshot.allocations.count) live allocations across \(snapshot.zoneNames.count) zones")
    for (i, name) in snapshot.zoneNames.enumerated() {
        let count = snapshot.allocations.lazy.filter { $0.zoneIndex == i }.count
        eprint("heapscope:   zone[\(i)] \"\(name)\" — \(count) allocations")
    }

    let roots = collectRoots(task: target)
    eprint("heapscope: \(roots.dataRanges.count) __DATA ranges, \(roots.stackRanges.count) stacks, \(roots.registerWords.count) register words")

    let graph = buildReachability(task: target, snapshot: snapshot, roots: roots)

    var leakedSet = Set<Int>()
    for i in 0..<graph.allocations.count where !graph.reachable[i] {
        leakedSet.insert(i)
    }
    let cycles = findCycles(graph: graph) { leakedSet.contains($0) }

    let report = LeakReport(pid: pid,
                            graph: graph,
                            zoneNames: snapshot.zoneNames,
                            cycles: cycles)
    try emitJSON(report: report, to: outputPath)

    let leakedBytes = leakedSet.reduce(UInt64(0)) { $0 &+ graph.allocations[$1].size }
    let reachableCount = graph.reachable.lazy.filter { $0 }.count

    // Plain console summary. ANSI colors are cheap enough that we always emit;
    // anyone piping output to a file can strip them with `sed`.
    let green = "\u{001B}[32m"
    let red   = "\u{001B}[31m"
    let dim   = "\u{001B}[2m"
    let reset = "\u{001B}[0m"

    print("")
    print("  total allocations  \(graph.allocations.count)")
    print("  reachable          \(green)\(reachableCount)\(reset)")
    print("  leaked             \(leakedSet.isEmpty ? green : red)\(leakedSet.count)\(reset)")
    print("  leaked bytes       \(leakedBytes)")
    print("  cycles found       \(cycles.count)")
    print("  \(dim)json →\(reset)          \(outputPath)")
    print("")
    if leakedSet.isEmpty {
        print("\(green)✓\(reset) no leaks detected")
    } else {
        print("\(red)✗\(reset) \(leakedSet.count) allocation(s) unreachable from any root")
    }
} catch {
    eprint("heapscope: \(error)")
    exit(1)
}
