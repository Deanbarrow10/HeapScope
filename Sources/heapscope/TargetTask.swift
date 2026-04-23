import Foundation
import HeapScopeC
import Darwin

struct TargetTask {
    let port: mach_port_t
    let pid: Int32

    static func attach(pid: Int32) throws -> TargetTask {
        var port: mach_port_t = 0
        let kr = hs_task_for_pid(pid, &port)
        guard kr == KERN_SUCCESS else {
            throw HeapScopeError.taskForPidFailed(kr: kr, pid: pid)
        }
        return TargetTask(port: port, pid: pid)
    }

    /// Suspend the target for a consistent heap snapshot. Every kernel thread is
    /// stopped so allocations can't shift underneath us while we enumerate zones,
    /// walk images, or read memory. The caller is responsible for resuming.
    func suspend() throws {
        let kr = hs_task_suspend(port)
        guard kr == KERN_SUCCESS else {
            throw HeapScopeError.taskSuspendFailed(kr: kr)
        }
    }

    func resume() {
        _ = hs_task_resume(port)
    }
}

enum HeapScopeError: Error, CustomStringConvertible {
    case taskForPidFailed(kr: kern_return_t, pid: Int32)
    case taskSuspendFailed(kr: kern_return_t)
    case enumerationFailed(kr: kern_return_t)

    var description: String {
        switch self {
        case .taskForPidFailed(let kr, let pid):
            return "task_for_pid(\(pid)) failed: kr=\(kr). Run with sudo; SIP or codesign restrictions can block attach to Apple-signed processes."
        case .taskSuspendFailed(let kr):
            return "task_suspend failed: kr=\(kr)"
        case .enumerationFailed(let kr):
            return "malloc_get_all_zones failed: kr=\(kr)"
        }
    }
}
