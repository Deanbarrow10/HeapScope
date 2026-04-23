#ifndef HEAPSCOPEC_H
#define HEAPSCOPEC_H

#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <malloc/malloc.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/// A live allocation recorded from a target malloc zone.
typedef struct {
    uint64_t address;
    uint64_t size;
    uint32_t zone_index;
} hs_allocation_t;

/// A contiguous memory range in the target to be scanned for pointer candidates.
/// kind: 0 = __DATA/__DATA_CONST segment, 1 = thread stack window.
typedef struct {
    uint64_t address;
    uint64_t size;
    uint32_t kind;
} hs_range_t;

/// Resolve a pid to its Mach task port. Requires sudo or a task_for_pid entitlement.
kern_return_t hs_task_for_pid(int pid, mach_port_t *out_task);

kern_return_t hs_task_suspend(mach_port_t task);
kern_return_t hs_task_resume(mach_port_t task);

/// Read `size` bytes from the target's address space into a newly-allocated local buffer.
/// The caller must release the buffer via `hs_free`.
kern_return_t hs_read_memory(mach_port_t task, uint64_t remote_addr, size_t size, void **out_buf);

void hs_free(void *buf);
void hs_free_strings(char **strings, size_t count);

/// Enumerate every live allocation across every malloc zone of the target process.
/// On return `out_allocs` is an array of `out_count` allocations, each tagged with its
/// zone index (0..out_zone_count-1). `out_zone_names[i]` is the `zone_name` read from
/// the target; caller frees with `hs_free`/`hs_free_strings`.
kern_return_t hs_enumerate_allocations(mach_port_t task,
                                       hs_allocation_t **out_allocs,
                                       size_t *out_count,
                                       char ***out_zone_names,
                                       size_t *out_zone_count);

/// Walk the target's dyld image list and record every __DATA / __DATA_CONST / __DATA_DIRTY
/// segment as a candidate root region.
kern_return_t hs_collect_data_ranges(mach_port_t task,
                                     hs_range_t **out_ranges,
                                     size_t *out_count);

/// For each thread of the target, record a 512KB window starting at __sp as a stack
/// root region, and flatten every general-purpose register (x0..x28, fp, lr) into
/// `out_register_words`. The registers are treated as candidate pointers by the caller.
kern_return_t hs_collect_thread_roots(mach_port_t task,
                                      hs_range_t **out_stack_ranges,
                                      size_t *out_stack_count,
                                      uint64_t **out_register_words,
                                      size_t *out_register_count);

#ifdef __cplusplus
}
#endif

#endif /* HEAPSCOPEC_H */
