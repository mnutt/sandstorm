use std::collections::{HashMap, HashSet};

pub struct Changes {
    reset: bool,
    pub upserts: Vec<usize>,
    removed: Vec<String>,
    order: Vec<String>,
}
impl Changes {
    pub fn between<T: PartialEq>(
        previous: Option<&[T]>,
        rows: &[T],
        key: impl Fn(&T) -> String,
    ) -> capnp::Result<Self> {
        let old: HashMap<_, _> = previous
            .unwrap_or_default()
            .iter()
            .map(|row| (key(row), row))
            .collect();
        let mut seen = HashSet::new();
        let mut result = Self {
            reset: previous.is_none(),
            upserts: vec![],
            removed: vec![],
            order: vec![],
        };
        for (index, row) in rows.iter().enumerate() {
            let id = key(row);
            if id.is_empty() || !seen.insert(id.clone()) {
                return Err(capnp::Error::failed("Invalid list projection keys".into()));
            }
            if old.get(&id).copied() != Some(row) {
                result.upserts.push(index);
            }
            result.order.push(id);
        }
        for row in previous.unwrap_or_default() {
            let id = key(row);
            if !seen.contains(&id) {
                result.removed.push(id);
            }
        }
        Ok(result)
    }
    pub fn write(&self, revision: u64, mut out: crate::shell_capnp::list_delta::Builder<'_>) {
        out.set_revision(revision);
        out.set_reset(self.reset);
        let mut removed = out.reborrow().init_removed(self.removed.len() as u32);
        for (i, key) in self.removed.iter().enumerate() {
            removed.set(i as u32, key);
        }
        let mut order = out.init_order(self.order.len() as u32);
        for (i, key) in self.order.iter().enumerate() {
            order.set(i as u32, key);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_order_and_sends_only_changed_rows() {
        let before = [("a", 1), ("b", 2), ("c", 3)];
        let after = [("c", 3), ("a", 4), ("d", 5)];
        let key = |r: &(&str, i32)| r.0.to_owned();
        let initial = Changes::between(None, &before, key).unwrap();
        assert!(initial.reset);
        assert_eq!(initial.upserts, [0, 1, 2]);
        let change = Changes::between(Some(&before), &after, key).unwrap();
        assert!(!change.reset);
        assert_eq!(change.upserts, [1, 2]);
        assert_eq!(change.removed, ["b"]);
        assert_eq!(change.order, ["c", "a", "d"]);
        assert!(Changes::between(Some(&after), &after, key)
            .unwrap()
            .upserts
            .is_empty());
        assert!(Changes::between(None, &[("a", 1), ("a", 2)], key).is_err());
        assert!(
            Changes::between::<(&str, i32)>(None, &[], key)
                .unwrap()
                .reset
        );
    }
}
