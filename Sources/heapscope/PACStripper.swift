import Foundation

/// Clears arm64e PAC + tag bits from a 64-bit word recovered from the target's memory,
/// yielding a plain virtual address suitable for comparing against the allocation set.
///
/// macOS on Apple Silicon uses 47-bit user virtual addresses (T1SZ = 17); bits 47..63
/// hold PAC bits plus sign extension. Masking is the right tool here because we can't
/// use `ptrauth_strip` — that would require knowing which key (instruction vs data)
/// and discriminator the target used when signing each pointer, and we're just trying
/// to decide whether a word could be a heap address, not to re-authenticate it.
///
/// Kept in sync with `HS_PAC_MASK` in `HeapScopeC.c`.
@inline(__always)
func stripPAC(_ word: UInt64) -> UInt64 {
    return word & 0x00007FFFFFFFFFFF
}
