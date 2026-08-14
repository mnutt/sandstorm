#pragma once

#include <kj/string.h>

// The pinned Cap'n Proto predates C++20's rewritten equality candidates and
// omits these overloads in C++20 mode. Its capnp/blob.h still calls them with
// the const char* operand first, so restore the upstream-compatible forms for
// the Node 24 addon build.
#if defined(__cpp_impl_three_way_comparison)
namespace kj {
inline bool operator==(const char* left, const StringPtr& right) {
  return right == left;
}

inline bool operator!=(const char* left, const StringPtr& right) {
  return !(right == left);
}
}  // namespace kj
#endif
