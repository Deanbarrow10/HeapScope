// LeakyVictim — a deliberately buggy target for HeapScope to analyze.
//
// Layout:
//   - 3 reachable 128-byte allocations, held via a file-scope globals table.
//   - 1 plain leak: a 64-byte block whose only pointer goes out of scope.
//   - 1 retain cycle: two heap nodes pointing to each other, with every
//     external reference dropped.
//
// After setup the program prints its pid and blocks in pause() so the analyzer
// can attach. Ctrl-C exits cleanly.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <stddef.h>

struct Node {
    struct Node *next;
    char payload[48];
};

static void *g_kept_alive[3];

static volatile sig_atomic_t should_exit = 0;

static void handle_sigint(int sig) { (void)sig; should_exit = 1; }

// Done in a helper so the references live entirely inside the helper's frame.
// When the helper returns, the frame becomes dead storage — heapscope's stack
// window won't find those pointers because our scrub buffer in main() will
// have overwritten them by the time analysis runs.
static void create_plain_leak(void) {
    char *orphan = (char *)malloc(64);
    if (!orphan) return;
    memset(orphan, 0xAA, 64);
    (void)orphan;
}

static void create_retain_cycle(void) {
    struct Node *a = (struct Node *)malloc(sizeof(struct Node));
    struct Node *b = (struct Node *)malloc(sizeof(struct Node));
    if (!a || !b) return;
    memset(a->payload, 0x11, sizeof(a->payload));
    memset(b->payload, 0x22, sizeof(b->payload));
    a->next = b;
    b->next = a;
    // a, b fall out of scope here; the only pointers to them live inside
    // each other's `next`, forming an unreachable cycle.
}

int main(int argc, char **argv) {
    (void)argc; (void)argv;

    for (int i = 0; i < 3; i++) {
        char *p = (char *)malloc(128);
        if (!p) return 1;
        memset(p, 0x42, 128);
        g_kept_alive[i] = p;
    }

    create_plain_leak();
    create_retain_cycle();

    // Scrub the stack area the helpers spilled into so heapscope's 512KB
    // stack-window scan doesn't accidentally resurrect a "dead" pointer from
    // an old frame. This is the same reason Instruments' Leaks recommends
    // stressing the stack between allocation and measurement.
    volatile unsigned char scrub[16 * 1024];
    for (size_t i = 0; i < sizeof(scrub); i++) scrub[i] = 0;
    __asm__ volatile("" : : "r"(scrub) : "memory");

    signal(SIGINT, handle_sigint);
    printf("LeakyVictim pid=%d — attach with: sudo heapscope %d\n", getpid(), getpid());
    printf("Press Ctrl-C to exit.\n");
    fflush(stdout);

    while (!should_exit) {
        pause();
    }
    return 0;
}
