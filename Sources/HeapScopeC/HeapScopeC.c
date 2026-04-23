// HeapScopeC — Mach / libmalloc glue that Swift can't cleanly express.
//
// Everything that requires vm_range_t arithmetic, malloc_zone_t / malloc_introspection_t
// field access, or calling a C function pointer recovered from a foreign task lives here.
// Swift consumes the results as flat arrays of C structs.

#include "HeapScopeC.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

#include <mach-o/loader.h>
#include <mach-o/dyld_images.h>
#include <mach/arm/thread_state.h>

// MALLOC_PTR_IN_USE_RANGE_TYPE is declared in <malloc/malloc.h> on modern SDKs.
#ifndef MALLOC_PTR_IN_USE_RANGE_TYPE
#define MALLOC_PTR_IN_USE_RANGE_TYPE 1
#endif

// Mask used to clear PAC/tag bits from a 64-bit address before comparing it against
// the target's allocation set. macOS on arm64e uses 47-bit user virtual addresses
// (T1SZ = 17); PAC bits live in 47..63. Keeping only bits 0..46 is the conservative
// strip that works for both plain 64-bit and arm64e. Duplicated in PACStripper.swift.
#define HS_PAC_MASK 0x00007FFFFFFFFFFFULL

// ---------------------------------------------------------------------------
// task_for_pid / suspend / resume
// ---------------------------------------------------------------------------

kern_return_t hs_task_for_pid(int pid, mach_port_t *out_task) {
    return task_for_pid(mach_task_self(), pid, out_task);
}

kern_return_t hs_task_suspend(mach_port_t task) { return task_suspend(task); }
kern_return_t hs_task_resume(mach_port_t task)  { return task_resume(task); }

// ---------------------------------------------------------------------------
// Memory access into the target task
// ---------------------------------------------------------------------------

// memory_reader_t callback for libmalloc's cross-task introspection.
// mach_vm_read allocates a fresh page-aligned region in our process; the buffer
// outlives a single enumeration pass. We leak these on purpose — the analyzer
// is a short-lived CLI, and deallocating during enumeration risks dangling
// pointers inside libmalloc's internal traversal.
static kern_return_t hs_reader_cb(task_t task, vm_address_t remote,
                                  vm_size_t size, void **local) {
    vm_offset_t data = 0;
    mach_msg_type_number_t data_cnt = 0;
    kern_return_t kr = mach_vm_read(task,
                                    (mach_vm_address_t)remote,
                                    (mach_vm_size_t)size,
                                    &data, &data_cnt);
    if (kr != KERN_SUCCESS) return kr;
    *local = (void *)(uintptr_t)data;
    return KERN_SUCCESS;
}

kern_return_t hs_read_memory(mach_port_t task, uint64_t addr,
                             size_t size, void **out_buf) {
    if (size == 0) { *out_buf = NULL; return KERN_SUCCESS; }
    void *buf = malloc(size);
    if (!buf) return KERN_FAILURE;
    mach_vm_size_t got = 0;
    kern_return_t kr = mach_vm_read_overwrite(task,
                                              (mach_vm_address_t)addr,
                                              (mach_vm_size_t)size,
                                              (mach_vm_address_t)(uintptr_t)buf,
                                              &got);
    if (kr != KERN_SUCCESS) { free(buf); return kr; }
    return KERN_SUCCESS;
}

void hs_free(void *buf) { free(buf); }

void hs_free_strings(char **strings, size_t count) {
    if (!strings) return;
    for (size_t i = 0; i < count; i++) free(strings[i]);
    free(strings);
}

// ---------------------------------------------------------------------------
// Zone enumeration
// ---------------------------------------------------------------------------

typedef struct {
    hs_allocation_t *allocs;
    size_t count;
    size_t capacity;
    uint32_t zone_index;
} hs_enum_ctx_t;

static void hs_recorder_cb(task_t task, void *context, unsigned type,
                           vm_range_t *ranges, unsigned n) {
    (void)task; (void)type;
    hs_enum_ctx_t *ctx = (hs_enum_ctx_t *)context;
    if (ctx->count + n > ctx->capacity) {
        size_t cap = ctx->capacity ? ctx->capacity : 256;
        while (cap < ctx->count + n) cap *= 2;
        ctx->allocs = (hs_allocation_t *)realloc(ctx->allocs,
                                                 cap * sizeof(hs_allocation_t));
        ctx->capacity = cap;
    }
    for (unsigned i = 0; i < n; i++) {
        ctx->allocs[ctx->count].address = (uint64_t)ranges[i].address;
        ctx->allocs[ctx->count].size    = (uint64_t)ranges[i].size;
        ctx->allocs[ctx->count].zone_index = ctx->zone_index;
        ctx->count++;
    }
}

// The enumerator function pointer is read out of the target's malloc_introspection_t.
// Because libmalloc ships in the dyld shared cache — which is mapped at the same
// base address in every process on a given boot — the function address recovered
// from the target is also valid in our address space. On arm64e the stored pointer
// may carry PAC bits; we strip them before calling.
typedef kern_return_t (*hs_enum_fn_t)(task_t, void *, unsigned,
                                      vm_address_t, memory_reader_t,
                                      vm_range_recorder_t);

kern_return_t hs_enumerate_allocations(mach_port_t task,
                                       hs_allocation_t **out_allocs,
                                       size_t *out_count,
                                       char ***out_zone_names,
                                       size_t *out_zone_count) {
    vm_address_t *zones = NULL;
    unsigned zone_count = 0;
    kern_return_t kr = malloc_get_all_zones(task, hs_reader_cb,
                                            &zones, &zone_count);
    if (kr != KERN_SUCCESS) return kr;

    hs_enum_ctx_t ctx = {0};
    char **names = (char **)calloc(zone_count ? zone_count : 1, sizeof(char *));

    for (unsigned i = 0; i < zone_count; i++) {
        ctx.zone_index = i;

        malloc_zone_t *zone = NULL;
        kr = hs_reader_cb(task, zones[i], sizeof(malloc_zone_t), (void **)&zone);
        if (kr != KERN_SUCCESS || !zone) {
            names[i] = strdup("<unreadable>");
            continue;
        }

        // Best-effort zone name: the struct member is a const char* in the target.
        char *nm = NULL;
        if (zone->zone_name) {
            char *remote_name = NULL;
            if (hs_reader_cb(task, (vm_address_t)zone->zone_name, 128,
                             (void **)&remote_name) == KERN_SUCCESS) {
                nm = strndup(remote_name, 128);
            }
        }
        names[i] = nm ? nm : strdup("zone");

        if (!zone->introspect) continue;
        malloc_introspection_t *intro = NULL;
        kr = hs_reader_cb(task, (vm_address_t)zone->introspect,
                          sizeof(malloc_introspection_t), (void **)&intro);
        if (kr != KERN_SUCCESS || !intro || !intro->enumerator) continue;

        hs_enum_fn_t fn = (hs_enum_fn_t)((uintptr_t)intro->enumerator & HS_PAC_MASK);
        kern_return_t ekr = fn(task, &ctx, MALLOC_PTR_IN_USE_RANGE_TYPE,
                               zones[i], hs_reader_cb, hs_recorder_cb);
        if (ekr != KERN_SUCCESS) {
            // Nano zone's cross-task enumerator is historically flaky on newer
            // libmalloc; we log and keep going rather than aborting the snapshot.
            fprintf(stderr,
                    "heapscope: zone %u (%s) enumerator returned %d — skipping\n",
                    i, names[i], ekr);
        }
    }

    *out_allocs = ctx.allocs;
    *out_count = ctx.count;
    *out_zone_names = names;
    *out_zone_count = zone_count;
    return KERN_SUCCESS;
}

// ---------------------------------------------------------------------------
// __DATA / __DATA_CONST segments from the target's dyld image list
// ---------------------------------------------------------------------------

static void hs_push_range(hs_range_t **arr, size_t *n, size_t *cap, hs_range_t r) {
    if (*n == *cap) {
        *cap = *cap ? *cap * 2 : 64;
        *arr = (hs_range_t *)realloc(*arr, *cap * sizeof(hs_range_t));
    }
    (*arr)[(*n)++] = r;
}

kern_return_t hs_collect_data_ranges(mach_port_t task,
                                     hs_range_t **out_ranges,
                                     size_t *out_count) {
    struct task_dyld_info dyld;
    mach_msg_type_number_t cnt = TASK_DYLD_INFO_COUNT;
    kern_return_t kr = task_info(task, TASK_DYLD_INFO,
                                 (task_info_t)&dyld, &cnt);
    if (kr != KERN_SUCCESS) return kr;

    struct dyld_all_image_infos *infos = NULL;
    kr = hs_reader_cb(task, (vm_address_t)dyld.all_image_info_addr,
                      sizeof(struct dyld_all_image_infos), (void **)&infos);
    if (kr != KERN_SUCCESS || !infos) return kr;

    uint32_t n = infos->infoArrayCount;
    if (n == 0 || infos->infoArray == NULL) {
        *out_ranges = NULL; *out_count = 0; return KERN_SUCCESS;
    }

    struct dyld_image_info *images = NULL;
    kr = hs_reader_cb(task, (vm_address_t)(uintptr_t)infos->infoArray,
                      sizeof(struct dyld_image_info) * n, (void **)&images);
    if (kr != KERN_SUCCESS || !images) return kr;

    hs_range_t *ranges = NULL;
    size_t rcount = 0, rcap = 0;

    for (uint32_t i = 0; i < n; i++) {
        vm_address_t load_addr = (vm_address_t)(uintptr_t)images[i].imageLoadAddress;
        if (!load_addr) continue;

        struct mach_header_64 mh;
        mach_vm_size_t got = 0;
        if (mach_vm_read_overwrite(task, load_addr, sizeof(mh),
                                   (mach_vm_address_t)(uintptr_t)&mh,
                                   &got) != KERN_SUCCESS) continue;
        if (mh.magic != MH_MAGIC_64) continue;

        uint8_t *lc_buf = NULL;
        if (hs_reader_cb(task, load_addr + sizeof(mh), mh.sizeofcmds,
                         (void **)&lc_buf) != KERN_SUCCESS) continue;

        // First pass: find __TEXT.vmaddr to compute slide.
        uint64_t text_vmaddr = 0;
        bool have_text = false;
        uint8_t *p = lc_buf;
        for (uint32_t c = 0; c < mh.ncmds; c++) {
            struct load_command *lc = (struct load_command *)p;
            if (lc->cmd == LC_SEGMENT_64) {
                struct segment_command_64 *sc = (struct segment_command_64 *)p;
                if (strncmp(sc->segname, "__TEXT", 16) == 0) {
                    text_vmaddr = sc->vmaddr;
                    have_text = true;
                    break;
                }
            }
            p += lc->cmdsize;
        }
        if (!have_text) continue;
        uint64_t slide = (uint64_t)load_addr - text_vmaddr;

        // Second pass: every segment whose name starts with "__DATA" is root material.
        p = lc_buf;
        for (uint32_t c = 0; c < mh.ncmds; c++) {
            struct load_command *lc = (struct load_command *)p;
            if (lc->cmd == LC_SEGMENT_64) {
                struct segment_command_64 *sc = (struct segment_command_64 *)p;
                if (strncmp(sc->segname, "__DATA", 6) == 0 && sc->vmsize > 0) {
                    hs_range_t r = {
                        .address = sc->vmaddr + slide,
                        .size = sc->vmsize,
                        .kind = 0
                    };
                    hs_push_range(&ranges, &rcount, &rcap, r);
                }
            }
            p += lc->cmdsize;
        }
    }

    *out_ranges = ranges;
    *out_count = rcount;
    return KERN_SUCCESS;
}

// ---------------------------------------------------------------------------
// Thread stacks + registers
// ---------------------------------------------------------------------------

kern_return_t hs_collect_thread_roots(mach_port_t task,
                                      hs_range_t **out_stacks,
                                      size_t *out_scount,
                                      uint64_t **out_regs,
                                      size_t *out_rcount) {
    thread_act_array_t threads = NULL;
    mach_msg_type_number_t tc = 0;
    kern_return_t kr = task_threads(task, &threads, &tc);
    if (kr != KERN_SUCCESS) return kr;

    hs_range_t *stacks = (hs_range_t *)calloc(tc ? tc : 1, sizeof(hs_range_t));
    size_t scount = 0;
    // 31 candidate words per thread: x0..x28 (29) + fp + lr.
    uint64_t *regs = (uint64_t *)calloc((tc ? tc : 1) * 31, sizeof(uint64_t));
    size_t rcount = 0;

    for (unsigned i = 0; i < tc; i++) {
        arm_thread_state64_t state;
        mach_msg_type_number_t scnt = ARM_THREAD_STATE64_COUNT;
        if (thread_get_state(threads[i], ARM_THREAD_STATE64,
                             (thread_state_t)&state, &scnt) != KERN_SUCCESS) continue;

        // Accessors strip arm64e PAC bits from sp / fp / lr consistently.
        uint64_t sp = arm_thread_state64_get_sp(state);
        uint64_t fp = arm_thread_state64_get_fp(state);
        uint64_t lr = arm_thread_state64_get_lr(state);

        // Stack grows down; valid data runs from sp upward. 512KB is a pragmatic
        // window — main threads usually have 8MB stacks but the live frames sit
        // near the top. Tight enough to keep scans fast, wide enough to cover
        // deep recursion in realistic programs.
        if (sp) {
            stacks[scount++] = (hs_range_t){ .address = sp, .size = 512 * 1024, .kind = 1 };
        }

        for (int j = 0; j < 29; j++) regs[rcount++] = state.__x[j];
        regs[rcount++] = fp;
        regs[rcount++] = lr;
    }

    for (unsigned i = 0; i < tc; i++) {
        mach_port_deallocate(mach_task_self(), threads[i]);
    }
    vm_deallocate(mach_task_self(), (vm_address_t)(uintptr_t)threads,
                  tc * sizeof(thread_act_t));

    *out_stacks = stacks;
    *out_scount = scount;
    *out_regs = regs;
    *out_rcount = rcount;
    return KERN_SUCCESS;
}
