//! TTL LRU 缓存 — Trust Profile 内存缓存
//!
//! 1000 agent × ~100B/profile = ~100KB (内存可忽略)

use dashmap::DashMap;
use std::time::{Duration, Instant};

pub struct TtlCache<V: Clone> {
    map: DashMap<String, (V, Instant)>,
    ttl: Duration,
}

impl<V: Clone> TtlCache<V> {
    pub fn new(ttl: Duration) -> Self {
        Self {
            map: DashMap::new(),
            ttl,
        }
    }

    pub fn get(&self, key: &str) -> Option<V> {
        let entry = self.map.get(key)?;
        if entry.1.elapsed() > self.ttl {
            drop(entry);
            self.map.remove(key);
            return None;
        }
        Some(entry.0.clone())
    }

    pub fn set(&self, key: String, value: V) {
        self.map.insert(key, (value, Instant::now()));
    }

    pub fn invalidate(&self, key: &str) {
        self.map.remove(key);
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }
}
