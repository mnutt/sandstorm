// A follow-up read or authorization check after a completed write cannot turn
// that write into an apparent policy rejection. Hide its result after revocation
// while preserving an uncertain outcome for the caller; never replay the write.
export async function confirmMutation(read) {
  try {
    return await read();
  } catch {
    throw Object.assign(new Error("Could not confirm the completed operation. Check its current state before trying again."), {status:500});
  }
}
