//! ESC/POS Raw Thermal Receipt Printer & RJ-11 Cash Drawer Kick Bridge (80mm Printers)
//! Supports direct TCP Port 9100 LAN thermal printers (Epson TM-T20/T88, Star, Xprinter).

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
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

/// Strip ESC/POS control sequences (< 0x20 and 0x7F DEL) from dynamic text fields
/// so untrusted SKU names, cashier labels, or payment strings cannot inject printer opcodes.
pub fn sanitize_escpos_text(input: &str) -> String {
    input
        .chars()
        .map(|c| {
            let code = c as u32;
            if code < 0x20 || code == 0x7F {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
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

    for line in &receipt.lines {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_esc_and_gs_control_bytes() {
        let dirty = "Coca\x1b@Cola\x1dp1\nLine";
        assert_eq!(sanitize_escpos_text(dirty), "Coca @Cola p1 Line");
    }
}

/// Transmit raw ESC/POS bytes to a LAN thermal printer (e.g., "192.168.1.50:9100").
pub fn send_to_lan_printer(addr: &str, payload: &[u8]) -> Result<(), String> {
    let socket: SocketAddr = addr.parse().map_err(|e| format!("Invalid printer addr: {e}"))?;
    let mut stream = TcpStream::connect_timeout(&socket, Duration::from_secs(3))
        .map_err(|e| format!("Failed connecting to printer {addr}: {e}"))?;
    stream
        .write_all(payload)
        .map_err(|e| format!("Failed writing ESC/POS bytes: {e}"))?;
    stream.flush().map_err(|e| format!("Flush error: {e}"))?;
    Ok(())
}
