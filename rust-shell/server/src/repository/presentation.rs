use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use mongodb::bson::Bson;

pub(super) fn at<'a>(document: &'a Document, path: &str) -> Option<&'a Bson> {
    let mut parts = path.split('.');
    let mut value = document.get(parts.next()?)?;
    for part in parts {
        value = value.as_document()?.get(part)?;
    }
    Some(value)
}
pub(super) fn string(document: &Document, path: &str) -> String {
    at(document, path)
        .and_then(Bson::as_str)
        .unwrap_or("")
        .into()
}
pub(super) fn millis(value: Option<&Bson>) -> Option<i64> {
    match value? {
        Bson::DateTime(v) => Some(v.timestamp_millis()),
        Bson::Int64(v) => Some(*v),
        Bson::Int32(v) => Some(*v as i64),
        Bson::Double(v) if v.is_finite() => Some(*v as i64),
        _ => None,
    }
}
pub(super) fn date(value: Option<&Bson>) -> String {
    let Some(Bson::DateTime(value)) = value else {
        return String::new();
    };
    let Ok(iso) = value.try_to_rfc3339_string() else {
        return String::new();
    };
    // Match Date.toISOString(), including zero milliseconds, for stable ordering.
    let Some((seconds, _)) = iso
        .split_once('.')
        .or_else(|| iso.strip_suffix('Z').map(|s| (s, "")))
    else {
        return String::new();
    };
    format!(
        "{seconds}.{:03}Z",
        value.timestamp_millis().rem_euclid(1000)
    )
}
pub(super) fn clipped(value: &str, bytes: usize, fallback: &str) -> String {
    let value = if value.is_empty() { fallback } else { value };
    String::from_utf8_lossy(&value.as_bytes()[..value.len().min(bytes)]).into_owned()
}
pub(super) fn truth(value: Option<&Bson>) -> bool {
    match value {
        None | Some(Bson::Null) | Some(Bson::Boolean(false)) => false,
        Some(Bson::Int32(0) | Bson::Int64(0)) => false,
        Some(Bson::String(v)) => !v.is_empty(),
        Some(Bson::Double(v)) => *v != 0.0 && !v.is_nan(),
        _ => true,
    }
}
pub(super) fn encode(value: &str) -> String {
    let mut result = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            result.push(b as char)
        } else {
            result.push_str(&format!("%{b:02X}"));
        }
    }
    result
}
pub(super) fn shared_title(owner: &Document) -> String {
    let upstream = string(owner, "upstreamTitle");
    if !upstream.is_empty() && !truth(at(owner, "renamed")) {
        upstream
    } else {
        string(owner, "title")
    }
}
pub(super) fn regex_literal(value: &str) -> String {
    let mut result = String::new();
    for c in value.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            result.push('\\');
        }
        result.push(c);
    }
    result
}

impl Repository {
    pub(super) fn canonical_picture(&self, user: &Document) -> String {
        let picture = string(user, "profile.picture");
        if !picture.is_empty() {
            return format!("{}/{}", self.static_prefix, encode(&picture));
        }
        let identicon = string(user, "profile.identicon");
        if identicon.is_empty() {
            String::new()
        } else {
            format!(
                "{}/identicon/{}?s=256",
                self.static_prefix,
                encode(&identicon.chars().take(32).collect::<String>())
            )
        }
    }
    pub(super) fn picture(&self, user: &Document) -> String {
        let picture = string(user, "profile.picture");
        if !picture.is_empty() {
            return format!("/profile-picture/{}", encode(&picture));
        }
        let identicon = string(user, "profile.identicon");
        if identicon.is_empty() {
            return String::new();
        }
        let digits: Vec<usize> = identicon
            .chars()
            .take(32)
            .map(|c| c.to_digit(16).unwrap_or(0) as usize)
            .chain(std::iter::repeat(0))
            .take(32)
            .collect();
        render_identicon(&digits, 256.0)
    }
    pub(super) fn icon(&self, app_id: &str, icon: Option<&Document>, grid: bool) -> String {
        if let Some(icon) = icon {
            let asset = string(icon, "assetId2xDpi");
            let asset = if asset.is_empty() {
                string(icon, "assetId")
            } else {
                asset
            };
            if !asset.is_empty() {
                return format!("{}/{}", self.static_prefix, encode(&asset));
            }
            if let Some(svg) = at(icon, "svg").and_then(Bson::as_str) {
                return format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg));
            }
            if let Some(Bson::Binary(bytes)) =
                at(icon, "png.dpi2x").or_else(|| at(icon, "png.dpi1x"))
            {
                return format!("data:image/png;base64,{}", STANDARD.encode(&bytes.bytes));
            }
        }
        identicon(app_id, if grid { 128.0 } else { 24.0 })
    }
    pub(super) fn package_icon(&self, package: Option<&Document>, grid: bool) -> String {
        let Some(package) = package else {
            return String::new();
        };
        let icon = if grid {
            at(package, "manifest.metadata.icons.appGrid")
        } else {
            at(package, "manifest.metadata.icons.grain")
                .or_else(|| at(package, "manifest.metadata.icons.appGrid"))
        };
        self.icon(
            &string(package, "appId"),
            icon.and_then(Bson::as_document),
            grid,
        )
    }
}

fn identicon(app_id: &str, size: f64) -> String {
    // Same mirrored 5x5 pattern and hue mapping as sandstorm-identicons.
    let alphabet = "0123456789acdefghjkmnpqrstuvwxyz";
    let digits: Vec<usize> = (0..32)
        .map(|i| {
            app_id
                .as_bytes()
                .get(i)
                .and_then(|b| alphabet.find(*b as char))
                .unwrap_or(0)
                % 16
        })
        .collect();
    render_identicon(&digits, size)
}

fn render_identicon(digits: &[usize], size: f64) -> String {
    let hue = digits[25..].iter().fold(0, |v, d| v * 16 + d) as f64 / 0xfffffff as f64 * 6.0;
    let sat = [
        0.85,
        0.85 - hue.fract() * 0.3,
        0.55,
        0.55,
        0.55 + hue.fract() * 0.3,
        0.85,
    ];
    let rgb = [
        sat[hue as usize % 6],
        sat[(hue as usize | 16) % 6],
        sat[(hue as usize | 8) % 6],
    ]
    .map(|v| (v * 256.0).floor() as u32);
    let margin = size * 0.08;
    let cell = (size - 2.0 * margin) / 5.0;
    let mut rects = String::new();
    for (i, digit) in digits.iter().take(15).enumerate() {
        if digit % 2 == 0 {
            let columns: &[usize] = match i / 5 {
                0 => &[2],
                1 => &[1, 3],
                _ => &[0, 4],
            };
            for x in columns {
                rects.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"{cell}\" height=\"{cell}\"/>",
                    *x as f64 * cell + margin,
                    (i % 5) as f64 * cell + margin
                ));
            }
        }
    }
    let color = format!("rgb({},{},{})", rgb[0], rgb[1], rgb[2]);
    let svg=format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\"><rect fill=\"rgb(240,240,240)\" width=\"{size}\" height=\"{size}\"/><g fill=\"{color}\" stroke=\"{color}\" stroke-width=\"{}\">{rects}</g></svg>",size*0.005);
    format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg))
}
