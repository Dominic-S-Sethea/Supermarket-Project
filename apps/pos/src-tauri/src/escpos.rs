//! ESC/POS Raw Thermal Receipt Printer & RJ-11 Cash Drawer Kick Bridge (80mm Printers)
//! Supports direct TCP Port 9100 LAN thermal printers (Epson TM-T20/T88, Star, Xprinter).

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::time::Duration;

/// ESC/POS init + bold + line feed + cut + RJ-11 drawer kick constants
const ESC_INIT: &[u8] = &[0x1B, 0x40];
const ALIGN_CENTER: &[u8] = &[0x1B, 0x61, 0x01];
const ALIGN_LEFT: &[u8] = &[0x1B, 0x61, 0x00];
const BOLD_ON: &[u8] = &[0x1B, 0x45, 0x01];
const BOLD_OFF: &[u8] = &[0x1B, 0x45, 0x00];
const PAPER_CUT: &[u8] = &[0x1D, 0x56, 0x41, 0x10];
/// Standard RJ-11 cash drawer kick pulse on Pin 2 (25ms ON, 250ms OFF)
pub const DRAWER_KICK_PULSE: &[u8] = &[0x1B, 0x70, 0x00, 0x19, 0xFA];
/// Hard upper bound for a single thermal receipt payload (prevents memory/LAN printer DoS)
pub const MAX_RECEIPT_BYTES: usize = 64 * 1024;
/// Maximum line items printed in a single receipt buffer
pub const MAX_RECEIPT_LINES: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptLine {
    pub name: String,
    pub pack_label: String,
    pub qty: i32,
    pub total_formatted: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptPayload {
    pub store_name: String,
    pub receipt_no: String,
    pub cashier: String,
    pub timestamp: String,
    pub lines: Vec<ReceiptLine>,
    pub discount_formatted: String,
    pub tax_formatted: String,
    pub total_formatted: String,
    pub payment_method: String,
    pub open_cash_drawer: bool,
}

/// Strip C0/C1 control sequences (including ESC 0x1B, GS 0x1D, DEL 0x7F, and U+0080..U+009F)
/// from dynamic text fields so untrusted SKU names, cashier labels, or payment strings cannot
/// inject ESC/POS opcodes or cash-drawer kick pulses.
pub fn sanitize_escpos_text(input: &str) -> String {
    input
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Standard raw/LPD/IPP thermal receipt printer TCP ports (Epson, Star, Xprinter, Bixolon).
pub const ALLOWED_PRINTER_PORTS: &[u16] = &[9100, 9101, 9102, 9103, 515, 631];

/// Validate that a target LAN printer socket address is strictly an RFC1918 / IPv6 ULA private
/// LAN address on an allowed printer port (9100-9103, 515, 631). Loopback is blocked by default
/// to prevent SSRF/local-service pivoting unless `allow_loopback` is explicitly enabled.
pub fn validate_lan_printer_addr_with_options(
    addr: &str,
    allow_loopback: bool,
) -> Result<SocketAddr, String> {
    let socket: SocketAddr = addr
        .trim()
        .parse()
        .map_err(|e| format!("Invalid printer addr: {e}"))?;
    if !ALLOWED_PRINTER_PORTS.contains(&socket.port()) {
        return Err(format!(
            "Printer port {} is not permitted (allowed thermal printer ports: 9100-9103, 515, 631).",
            socket.port()
        ));
    }
    let is_loopback = socket.ip().is_loopback();
    if is_loopback && !allow_loopback {
        return Err(format!(
            "Refusing to connect to loopback printer address {} unless explicitly enabled.",
            socket.ip()
        ));
    }
    let allowed = match socket.ip() {
        IpAddr::V4(v4) => v4.is_private() || (allow_loopback && v4.is_loopback()),
        IpAddr::V6(v6) => {
            let seg0 = v6.segments()[0];
            (seg0 & 0xfe00) == 0xfc00 || (allow_loopback && v6.is_loopback())
        }
    };
    if !allowed {
        return Err(format!(
            "Refusing to connect to non-LAN printer address: {}",
            socket.ip()
        ));
    }
    Ok(socket)
}

/// Validate a LAN printer socket address with strict production defaults (RFC1918/ULA + printer ports only).
/// Set `SMOS_ALLOW_LOOPBACK_PRINTER=1` only for local printer simulator development.
pub fn validate_lan_printer_addr(addr: &str) -> Result<SocketAddr, String> {
    let allow_loopback = std::env::var("SMOS_ALLOW_LOOPBACK_PRINTER")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    validate_lan_printer_addr_with_options(addr, allow_loopback)
}

/// Build an 80mm (48-char width) ESC/POS byte buffer ready to stream to TCP:9100 or USB.
pub fn build_escpos_receipt(receipt: &ReceiptPayload) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    buf.extend_from_slice(ESC_INIT);
    buf.extend_from_slice(ALIGN_CENTER);
    buf.extend_from_slice(BOLD_ON);
    buf.extend_from_slice(format!("{}\n", sanitize_escpos_text(&receipt.store_name)).as_bytes());
    buf.extend_from_slice(BOLD_OFF);
    buf.extend_from_slice(
        format!("Receipt: {}\n", sanitize_escpos_text(&receipt.receipt_no)).as_bytes(),
    );
    buf.extend_from_slice(
        format!(
            "{} | {}\n",
            sanitize_escpos_text(&receipt.timestamp),
            sanitize_escpos_text(&receipt.cashier)
        )
        .as_bytes(),
    );
    buf.extend_from_slice(b"------------------------------------------------\n");
    buf.extend_from_slice(ALIGN_LEFT);

    for line in receipt.lines.iter().take(MAX_RECEIPT_LINES) {
        let label = format!(
            "{}x {} ({})",
            line.qty,
            sanitize_escpos_text(&line.name),
            sanitize_escpos_text(&line.pack_label)
        );
        let trimmed: String = label.chars().take(36).collect();
        let row = format!(
            "{:<36}{:>12}\n",
            trimmed,
            sanitize_escpos_text(&line.total_formatted)
        );
        buf.extend_from_slice(row.as_bytes());
    }

    buf.extend_from_slice(b"------------------------------------------------\n");
    buf.extend_from_slice(
        format!(
            "{:<36}{:>12}\n",
            "Promotions / Discount:",
            sanitize_escpos_text(&receipt.discount_formatted)
        )
        .as_bytes(),
    );
    buf.extend_from_slice(
        format!(
            "{:<36}{:>12}\n",
            "Included Tax:",
            sanitize_escpos_text(&receipt.tax_formatted)
        )
        .as_bytes(),
    );
    buf.extend_from_slice(BOLD_ON);
    buf.extend_from_slice(
        format!(
            "{:<36}{:>12}\n",
            "TOTAL:",
            sanitize_escpos_text(&receipt.total_formatted)
        )
        .as_bytes(),
    );
    buf.extend_from_slice(BOLD_OFF);
    buf.extend_from_slice(
        format!(
            "{:<36}{:>12}\n",
            "Tender:",
            sanitize_escpos_text(&receipt.payment_method)
        )
        .as_bytes(),
    );
    buf.extend_from_slice(b"\n");
    buf.extend_from_slice(ALIGN_CENTER);
    buf.extend_from_slice(b"Thank you for shopping with us!\n\n\n");
    buf.extend_from_slice(PAPER_CUT);

    if receipt.open_cash_drawer {
        buf.extend_from_slice(DRAWER_KICK_PULSE);
    }
    buf
}

/// Transmit raw ESC/POS bytes to a validated LAN thermal printer (e.g., "192.168.1.50:9100").
pub fn send_to_lan_printer(addr: &str, payload: &[u8]) -> Result<(), String> {
    if payload.is_empty() {
        return Err("Refusing to send empty ESC/POS payload.".to_string());
    }
    if payload.len() > MAX_RECEIPT_BYTES {
        return Err(format!(
            "ESC/POS payload ({} bytes) exceeds maximum allowed {} bytes.",
            payload.len(),
            MAX_RECEIPT_BYTES
        ));
    }
    let socket = validate_lan_printer_addr(addr)?;
    let mut stream = TcpStream::connect_timeout(&socket, Duration::from_secs(3))
        .map_err(|e| format!("Failed connecting to printer {addr}: {e}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| format!("Failed setting printer write timeout: {e}"))?;
    stream
        .write_all(payload)
        .map_err(|e| format!("Failed writing ESC/POS bytes: {e}"))?;
    stream.flush().map_err(|e| format!("Flush error: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_c0_and_c1_control_bytes() {
        let dirty = "Coca\x1b@Cola\x1dp1\nLine\u{0085}End\x7f";
        assert_eq!(sanitize_escpos_text(dirty), "Coca @Cola p1 Line End");
    }

    #[test]
    fn validate_lan_printer_allows_rfc1918_printer_ports_and_blocks_loopback_by_default() {
        assert!(validate_lan_printer_addr_with_options("192.168.1.50:9100", false).is_ok());
        assert!(validate_lan_printer_addr_with_options("10.0.4.12:9101", false).is_ok());
        assert!(validate_lan_printer_addr_with_options("172.16.8.20:631", false).is_ok());
        assert!(validate_lan_printer_addr_with_options("192.168.1.50:515", false).is_ok());
        // Loopback blocked by default to prevent SSRF / local-service pivoting
        assert!(validate_lan_printer_addr_with_options("127.0.0.1:9100", false).is_err());
        assert!(validate_lan_printer_addr_with_options("[::1]:9100", false).is_err());
        // Explicit opt-in permits loopback on standard printer ports only
        assert!(validate_lan_printer_addr_with_options("127.0.0.1:9100", true).is_ok());
        assert!(validate_lan_printer_addr_with_options("[::1]:9100", true).is_ok());
        assert!(validate_lan_printer_addr_with_options("127.0.0.1:5432", true).is_err());
    }

    #[test]
    fn validate_lan_printer_blocks_public_metadata_non_printer_ports_and_zero_port() {
        assert!(validate_lan_printer_addr_with_options("169.254.169.254:80", false).is_err());
        assert!(validate_lan_printer_addr_with_options("8.8.8.8:9100", false).is_err());
        assert!(validate_lan_printer_addr_with_options("192.168.1.50:0", false).is_err());
        assert!(validate_lan_printer_addr_with_options("192.168.1.50:22", false).is_err());
        assert!(validate_lan_printer_addr_with_options("192.168.1.50:5432", false).is_err());
        assert!(validate_lan_printer_addr_with_options("not-an-ip", false).is_err());
    }

    #[test]
    fn send_to_lan_printer_rejects_empty_and_oversized_payloads() {
        assert!(send_to_lan_printer("127.0.0.1:9100", &[]).is_err());
        let huge = vec![b'A'; MAX_RECEIPT_BYTES + 1];
        assert!(send_to_lan_printer("127.0.0.1:9100", &huge).is_err());
    }

    #[test]
    fn receipt_without_drawer_kick_omits_pulse() {
        let payload = ReceiptPayload {
            store_name: "STORE\x1bp".to_string(),
            receipt_no: "R-1".to_string(),
            cashier: "Alex".to_string(),
            timestamp: "2026-11-25 12:00".to_string(),
            lines: vec![ReceiptLine {
                name: "Milk 1L".to_string(),
                pack_label: "Single".to_string(),
                qty: 2,
                total_formatted: "$4.00".to_string(),
            }],
            discount_formatted: "$0.00".to_string(),
            tax_formatted: "$0.36".to_string(),
            total_formatted: "$4.00".to_string(),
            payment_method: "CARD".to_string(),
            open_cash_drawer: false,
        };
        let bytes = build_escpos_receipt(&payload);
        assert!(bytes.starts_with(ESC_INIT));
        assert!(bytes.ends_with(PAPER_CUT));
        assert!(!bytes.ends_with(DRAWER_KICK_PULSE));
    }

    #[test]
    fn receipt_payload_round_trips_through_serde_json() {
        let json = r#"{
            "store_name":"SupermarketOS",
            "receipt_no":"REG-01-9999",
            "cashier":"Elena",
            "timestamp":"2026-11-25 14:00",
            "lines":[{"name":"Soda","pack_label":"6-Pack","qty":1,"total_formatted":"$5.50"}],
            "discount_formatted":"$0.00",
            "tax_formatted":"$0.50",
            "total_formatted":"$5.50",
            "payment_method":"CARD",
            "open_cash_drawer":false
        }"#;
        let parsed: ReceiptPayload = serde_json::from_str(json).expect("valid JSON receipt");
        let reencoded = serde_json::to_string(&parsed).expect("re-serialize receipt");
        assert!(reencoded.contains("REG-01-9999"));
        let bytes = build_escpos_receipt(&parsed);
        assert!(bytes.len() < MAX_RECEIPT_BYTES);
    }
}
