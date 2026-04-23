import Foundation

struct LeakReport {
    let pid: Int32
    let graph: Graph
    let zoneNames: [String]
    let cycles: [Cycle]
}

/// Emit the analysis as JSON. Written by hand rather than via `JSONEncoder` so
/// field ordering is stable across runs (useful when diffing two snapshots) and
/// so we don't pay the cost of materializing intermediate `[String: Any]`
/// dictionaries for large graphs.
func emitJSON(report: LeakReport, to path: String) throws {
    let allocs = report.graph.allocations
    let reachable = report.graph.reachable

    var inCycle = Array(repeating: false, count: allocs.count)
    for c in report.cycles {
        for n in c.members { inCycle[n] = true }
    }

    var leakedBytes: UInt64 = 0
    var leakedCount = 0
    for i in 0..<allocs.count where !reachable[i] {
        leakedCount += 1
        leakedBytes &+= allocs[i].size
    }
    let reachableCount = reachable.lazy.filter { $0 }.count

    var s = ""
    s.reserveCapacity(allocs.count * 80)
    s += "{\n"
    s += "  \"pid\": \(report.pid),\n"
    s += "  \"summary\": {\n"
    s += "    \"total_allocations\": \(allocs.count),\n"
    s += "    \"reachable\": \(reachableCount),\n"
    s += "    \"leaked\": \(leakedCount),\n"
    s += "    \"leaked_bytes\": \(leakedBytes),\n"
    s += "    \"cycles_found\": \(report.cycles.count)\n"
    s += "  },\n"

    s += "  \"nodes\": [\n"
    for i in 0..<allocs.count {
        let a = allocs[i]
        let zone = a.zoneIndex < report.zoneNames.count ? report.zoneNames[a.zoneIndex] : "zone"
        let id = hex(a.address)
        s += "    {\"id\":\"\(id)\",\"size\":\(a.size),\"zone\":\"\(escape(zone))\",\"reachable\":\(reachable[i]),\"in_cycle\":\(inCycle[i])}"
        s += (i == allocs.count - 1) ? "\n" : ",\n"
    }
    s += "  ],\n"

    s += "  \"edges\": [\n"
    var first = true
    for from in 0..<allocs.count {
        for to in report.graph.edges[from] {
            if !first { s += ",\n" }
            first = false
            s += "    {\"from\":\"\(hex(allocs[from].address))\",\"to\":\"\(hex(allocs[to].address))\"}"
        }
    }
    if !first { s += "\n" }
    s += "  ],\n"

    s += "  \"cycles\": [\n"
    for (ci, c) in report.cycles.enumerated() {
        let ids = c.members.map { "\"\(hex(allocs[$0].address))\"" }
        s += "    [\(ids.joined(separator: ","))]"
        s += (ci == report.cycles.count - 1) ? "\n" : ",\n"
    }
    s += "  ]\n"
    s += "}\n"

    try s.write(toFile: path, atomically: true, encoding: .utf8)
}

@inline(__always)
private func hex(_ v: UInt64) -> String {
    return "0x" + String(v, radix: 16)
}

private func escape(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.count)
    for c in s {
        switch c {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\t": out += "\\t"
        default:
            if let v = c.asciiValue, v < 0x20 {
                out += String(format: "\\u%04x", Int(v))
            } else {
                out.append(c)
            }
        }
    }
    return out
}
