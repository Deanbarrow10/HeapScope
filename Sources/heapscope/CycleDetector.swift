import Foundation

struct Cycle {
    /// Indices into `Graph.allocations`.
    let members: [Int]
}

/// Tarjan's strongly connected components, restricted to the subgraph induced by
/// `isMember`. A retain cycle is either an SCC of size ≥ 2 or a single node whose
/// edge list contains itself (direct self-loop).
///
/// Implementation is recursive for clarity. For leaked subgraphs with < ~10^5
/// nodes the Swift call stack is comfortable; a production analyzer on huge
/// heaps would swap in an explicit-stack variant.
func findCycles(graph: Graph, isMember: (Int) -> Bool) -> [Cycle] {
    let n = graph.allocations.count
    var index = Array(repeating: -1, count: n)
    var lowlink = Array(repeating: 0, count: n)
    var onStack = Array(repeating: false, count: n)
    var stack: [Int] = []
    var counter = 0
    var cycles: [Cycle] = []

    func strongConnect(_ v: Int) {
        index[v] = counter
        lowlink[v] = counter
        counter += 1
        stack.append(v)
        onStack[v] = true

        for w in graph.edges[v] where isMember(w) {
            if index[w] == -1 {
                strongConnect(w)
                lowlink[v] = min(lowlink[v], lowlink[w])
            } else if onStack[w] {
                lowlink[v] = min(lowlink[v], index[w])
            }
        }

        if lowlink[v] == index[v] {
            var scc: [Int] = []
            while let top = stack.popLast() {
                onStack[top] = false
                scc.append(top)
                if top == v { break }
            }
            if scc.count >= 2 {
                cycles.append(Cycle(members: scc))
            } else if scc.count == 1 && graph.edges[v].contains(v) {
                cycles.append(Cycle(members: scc))
            }
        }
    }

    for v in 0..<n where isMember(v) && index[v] == -1 {
        strongConnect(v)
    }
    return cycles
}
