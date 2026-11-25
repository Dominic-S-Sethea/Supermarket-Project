pub mod escpos;

#[cfg(test)]
mod tests {
    use super::escpos::{build_escpos_receipt, DRAWER_KICK_PULSE, ReceiptLine, ReceiptPayload};

    #[test]
    fn builds_valid_escpos_receipt_with_drawer_kick() {
        let payload = ReceiptPayload {
            store_name: "SUPERMARKET OS - LANE 01".to_string(),
            receipt_no: "REG-01-000042".to_string(),
            cashier: "Elena Morales".to_string(),
            timestamp: "2026-11-25 18:15".to_string(),
            lines: vec![
                ReceiptLine {
                    name: "Heineken Original 330ml".to_string(),
                    pack_label: "6-Pack".to_string(),
                    qty: 1,
                    total_formatted: "$9.95".to_string(),
                },
                ReceiptLine {
                    name: "Indomie Mi Goreng 85g".to_string(),
                    pack_label: "Single Pack".to_string(),
                    qty: 5,
                    total_formatted: "$3.95".to_string(),
                },
            ],
            discount_formatted: "-$1.05".to_string(),
            tax_formatted: "$1.29".to_string(),
            total_formatted: "$13.90".to_string(),
            payment_method: "CASH".to_string(),
            open_cash_drawer: true,
        };

        let bytes = build_escpos_receipt(&payload);
        assert!(bytes.starts_with(&[0x1B, 0x40]));
        assert!(bytes.ends_with(DRAWER_KICK_PULSE));
        let lossy = String::from_utf8_lossy(&bytes);
        assert!(lossy.contains("REG-01-000042"));
        assert!(lossy.contains("Heineken Original"));
        assert!(lossy.contains("$13.90"));
    }
}
