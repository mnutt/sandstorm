@0xaca401820427b18d;

interface FileStore {
  listDirectory @0 (path :Text) -> (entries :List(DirectoryEntry));
  stat @1 (path :Text) -> (entry :DirectoryEntry);
  readFile @2 (path :Text) -> (content :Data, contentType :Text);
  openFile @3 (path :Text) -> (file :File);

  struct DirectoryEntry {
    name @0 :Text;
    path @1 :Text;
    kind @2 :Text;
    size @3 :UInt64;
    contentType @4 :Text;
  }
}

interface File {
  stat @0 () -> (entry :FileStore.DirectoryEntry);
  read @1 () -> (content :Data, contentType :Text);
}
