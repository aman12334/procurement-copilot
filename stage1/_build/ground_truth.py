"""Builds the canonical (golden) interpretation of every vendor x RFx line."""
from model import *

FX = EVENT["evaluation_fx"]["USD_INR"]
LOAD = EVENT["freight_loading_pct"] / 100

SOURCE = {
    "VND-1001": ("excel", "vendors/vendor_1/Deccan_Corrupack_Quotation_SCPL_RFQ014.xlsx"),
    "VND-1002": ("pdf", "vendors/vendor_2/Shree_Ganesh_Packwell_Quotation_SGP-Q-2026-1187.pdf"),
    "VND-1003": ("docx", "vendors/vendor_3/Indus_Fibreboard_Offer_SCPL_RFQ014.docx"),
    "VND-1004": ("image", "images/vendor_4_rate_card_*.png (source print: vendors/vendor_4/Sri_Vaigai_Rate_Card_Oct2026.pdf)"),
    "VND-1005": ("email", "vendors/vendor_5/Godavari_Packaging_email_response.txt"),
}

# Document location of each line (filled in by vendor writers' fixed layouts; kept here so GT is self-contained)
V1_ROW_ORDER = sorted(LINES, key=lambda l: ({"BLR": 0, "HYD": 1, "PNQ": 2}[l["delivery_plant"]], l["line_id"]))
V1_FIRST_ROW = 10  # Excel row of first data line on sheet "Quotation"

V2_ORDER = sorted([l for l in LINES if l["line_id"] not in COVERAGE_MISSING["VND-1002"]],
                  key=lambda l: (l["ply"], l["price_category"] in ("PT", "PAD"), l["line_id"]))
V2_PAGE1_ROWS = 14


def v1_loc(lid):
    idx = [l["line_id"] for l in V1_ROW_ORDER].index(lid)
    return f"Sheet 'Quotation', row {V1_FIRST_ROW + idx}"


def v2_loc(lid):
    idx = [l["line_id"] for l in V2_ORDER].index(lid)
    page = 1 if idx < V2_PAGE1_ROWS else 2
    return f"Page {page}, price table, Sl. {idx + 1}"


def v3_loc(lid):
    if lid in V3_USD_LINES:
        return "Section 2 'Export-grade cartons' (prose)"
    return "Section 1 price schedule table (Table 1)"


def v4_loc(lid):
    return "Rate card table, row 'Your Code " + lid + "'"


def v5_loc(lid):
    l = LINE_BY_ID[lid]
    if lid in V5_LAST_YEAR_LINES:
        return "Email body paragraph on Hyderabad trays/inserts ('same as last year's pricing')"
    return "Email body, rate bullet for '" + {"P3": "3-ply plain", "P5": "5-ply plain", "HD5": "heavy-duty BF22 5-ply", "PR3": "printed 3-ply", "PR5": "printed 5-ply", "PT": "partitions & pads", "PAD": "partitions & pads"}[l["price_category"]] + "'"


LOCS = {"VND-1001": v1_loc, "VND-1002": v2_loc, "VND-1003": v3_loc, "VND-1004": v4_loc, "VND-1005": v5_loc}


def build_line_records():
    recs = []
    for v in VENDORS:
        vid = v["vendor_id"]
        t = TERMS[vid]
        doc_type, doc_file = SOURCE[vid]
        for l in LINES:
            lid, plant, hist = l["line_id"], l["delivery_plant"], l["historical_price_inr"]
            r = {
                "vendor_id": vid, "vendor_name": v["vendor_name"], "line_id": lid,
                "rfx_description": l["item_description"], "delivery_plant": plant, "annual_qty": l["annual_qty"],
                "source_document_type": doc_type, "source_file": doc_file,
                "historical_price_inr": hist,
                "payment_terms": t["payment_terms"], "price_validity_until": t["price_validity_until"],
                "tax_treatment": "Exclusive of GST",
                "edge_case_ids": [], "hitl_reasons": [], "ambiguity": None,
            }
            q = QUOTES[vid].get(lid)
            if q is None:
                r.update({"quote_status": "not_quoted", "source_location": None, "raw_price_text": None, "quoted_price": None,
                          "quoted_currency": None, "quoted_uom": None, "pieces_per_quoted_unit": None, "fx_rate_to_inr": None,
                          "normalized_unit_price_inr": None, "freight_treatment": None, "freight_inr_per_unit": None,
                          "freight_is_estimated": None, "landed_unit_price_inr": None, "variance_vs_historical_pct": None,
                          "moq": None, "moq_exceeds_monthly_calloff": None, "lead_time_days": None,
                          "extraction_confidence": "high", "comparable": False, "hitl_required": False})
                recs.append(r)
                continue

            r["quote_status"] = "quoted"
            r["source_location"] = LOCS[vid](lid)
            r["quoted_currency"] = q["currency"]
            r["fx_rate_to_inr"] = FX if q["currency"] == "USD" else 1.0
            conf, comparable = "high", True
            moq, lead = None, None

            # ---------- normalized price (INR / piece, ex-freight, ex-GST)
            if vid == "VND-1005":
                if q["uom"] == "per kg":
                    norm = r2(q["price"] * l["reference_weight_g"] / 1000)
                    r.update({"quoted_price": q["price"], "quoted_uom": "per kg", "pieces_per_quoted_unit": None,
                              "kg_per_piece_used": l["reference_weight_g"] / 1000,
                              "raw_price_text": f"Rs {q['price']:.0f}/kg"})
                    conf = "medium"
                    r["conversion_note"] = f"Per-kg rate x RFx reference box weight {l['reference_weight_g']} g"
                else:
                    norm = q["last_year_price"]
                    r.update({"quoted_price": None, "quoted_uom": "same as last year's pricing", "pieces_per_quoted_unit": 1,
                              "raw_price_text": "same as last year's pricing"})
                    conf = "low"
                    r["ambiguity"] = "Price given by reference to last year. Resolved to FY25-26 PO price from historical_reference_prices.csv (vendor was last-year supplier). Last year's PO was FOR Hyderabad, but the email says 'freight extra' – freight basis unclear."
                    r["hitl_reasons"].append("Price inferred from 'same as last year's pricing' – confirm value and freight basis with vendor")
                    r["edge_case_ids"].append("EC-17")
                moq = 5000 if l["printing"] != "Plain" else None
                lead = 10
            else:
                price, ppu = q["price"], q["pieces_per_unit"]
                norm = r2(price * r["fx_rate_to_inr"] / ppu)
                r.update({"quoted_price": price, "quoted_uom": q["uom"], "pieces_per_quoted_unit": ppu})
                if q["currency"] == "USD":
                    r["raw_price_text"] = f"USD {price:.2f} per piece"
                elif ppu == 100:
                    r["raw_price_text"] = f"Rs {price:,.2f} per 100 nos"
                else:
                    r["raw_price_text"] = f"{price:.2f}"
                moq = q.get("moq")
                lead = q.get("lead_time_days")

            # ---------- freight
            ft = t["freight_treatment"]
            if ft == "quoted_separately":
                fr, est, ftxt = q["freight_inr"], False, "Quoted separately per piece (delivered)"
            elif ft == "included":
                fr, est, ftxt = 0.0, False, "Included (FOR destination)"
            elif ft == "included_PNQ_only":
                if plant == "PNQ":
                    fr, est, ftxt = 0.0, False, "Included (FOR Chakan)"
                else:
                    fr, est, ftxt = r2(norm * LOAD), True, "Extra at actuals (footnote) – 5% evaluation loading applied"
            else:
                fr, est, ftxt = r2(norm * LOAD), True, "Excluded – 5% evaluation loading applied"
            landed = r2(norm + fr)
            r.update({"normalized_unit_price_inr": norm, "freight_treatment": ftxt, "freight_inr_per_unit": fr,
                      "freight_is_estimated": est, "landed_unit_price_inr": landed,
                      "variance_vs_historical_pct": round((landed - hist) / hist * 100, 1)})

            # ---------- vendor-specific MOQ / lead time
            if vid == "VND-1002":
                moq = 5000 if l["price_category"] == "PT" else 3000
                lead = 15
            if vid == "VND-1003":
                lead = 28 if lid in ("CP-015", "CP-017") else 14
                r["lead_time_note"] = "First supply 28 days, repeat 14 days" if lid in ("CP-015", "CP-017") else None
            if vid == "VND-1004":
                moq, lead = 1000, 7
            r["moq"] = moq
            r["moq_exceeds_monthly_calloff"] = (moq > l["monthly_calloff_qty"]) if moq else None
            r["lead_time_days"] = lead

            # ---------- planted per-line edge cases
            if vid == "VND-1001" and lid == V1_OUTLIER_LINE:
                r["edge_case_ids"].append("EC-14")
                r["hitl_reasons"].append("Possible price outlier: 140% above historical and ~2x other vendors")
                r["ambiguity"] = "Price is plausible as typed but statistically anomalous; may be keying error or sleeve misread as full carton"
                conf = "high"
            if vid == "VND-1001" and lid == "CP-018":
                r["raw_price_text"] = f"{q['price']:.2f} (incl. tear strip)"
                r["edge_case_ids"].append("EC-02")
            if vid == "VND-1002" and lid in V2_PER100_LINES:
                r["edge_case_ids"].append("EC-05")
                conf = "medium"
            if vid == "VND-1002" and lid == V2_DUPLICATE_LINE:
                dup = q["duplicate_price"]
                r["quote_status"] = "quoted_ambiguous"
                r["candidate_prices"] = [q["price"], dup]
                r["normalized_unit_price_inr"] = dup
                fr = 0.0
                r["landed_unit_price_inr"] = dup
                r["variance_vs_historical_pct"] = round((dup - hist) / hist * 100, 1)
                r["raw_price_text"] = f"{q['price']:.2f} (page 1) / {dup:.2f} (page 2 repeat)"
                r["source_location"] = v2_loc(lid) + "; repeated at end of page 2 table"
                r["ambiguity"] = "Line appears twice with slightly different descriptions and prices. Conservative (higher) value used for evaluation."
                r["hitl_reasons"].append("Duplicate SKU with conflicting prices – vendor clarification required")
                r["edge_case_ids"].append("EC-15")
                conf = "low"
            if vid == "VND-1002" and plant != "PNQ":
                r["edge_case_ids"].append("EC-08")
                conf = "medium" if conf == "high" else conf
            if vid == "VND-1003" and lid in V3_USD_LINES:
                r["edge_case_ids"].append("EC-04")
                r["conversion_note"] = f"USD x {FX} (RFx evaluation FX rate)"
            if vid == "VND-1003" and lid == V3_MISMATCH_LINE:
                r["edge_case_ids"].append("EC-16")
                r["ambiguity"] = "Vendor description says 450 x 350 x 300 (CP-007 size) under code CP-014 (RFx: 450 x 350 x 250, BF22). Item code and BF22 grade indicate CP-014; dimension mismatch needs confirmation."
                r["hitl_reasons"].append("SKU description/dimension mismatch – confirm quoted size")
                conf = "medium"
            if vid == "VND-1003" and lid == "CP-015":
                r["edge_case_ids"].append("EC-11")
                r["moq_source"] = "Prose (Section 3), table shows 'Refer note'"
            if vid == "VND-1003" and lid in ("CP-015", "CP-017"):
                r["edge_case_ids"].append("EC-12")
            if vid == "VND-1004":
                r["image_note"] = "Clearly legible in vendor_4_rate_card_clear.png"
                if lid in V4_PER100_LINES:
                    r["edge_case_ids"].append("EC-06")
                else:
                    r["edge_case_ids"].append("EC-07")
            if vid == "VND-1004" and lid == V4_HANDWRITTEN_LINE:
                r["quote_status"] = "quoted_ambiguous"
                r["candidate_prices"] = [q["price"], q["printed_struck_value"]]
                r["raw_price_text"] = f"printed {q['printed_struck_value']:.2f} struck through, handwritten {q['price']:.2f}"
                r["ambiguity"] = "Printed rate struck out with an uninitialled handwritten correction; handwriting digit legibility varies across images. Handwritten value taken as intended rate."
                r["hitl_reasons"].append("Ambiguous image-based price (handwritten correction) – confirm with vendor")
                r["edge_case_ids"].append("EC-13")
                conf = "low"
            if vid == "VND-1004" and lid == V4_BLURRED_LINE:
                r["image_note"] = "Row partially smudged/blurred in vendor_4_rate_card_partial.png; legible in clear image"
                r["edge_case_ids"].append("EC-20")
                conf = "medium"
            if vid == "VND-1004" and lid == V4_NONCOMPLIANT_LINE:
                r["quote_status"] = "quoted_non_compliant"
                comparable = False
                r["ambiguity"] = "Quoted with remark 'without WR coating' – does not meet moisture-resistant specification"
                r["hitl_reasons"].append("Specification deviation – quote not like-for-like")
                r["edge_case_ids"].append("EC-21")
            if vid == "VND-1005" and q["uom"] == "per kg":
                r["edge_case_ids"].append("EC-09")
                if l["price_category"] == "HD5":
                    r["conversion_note"] += " (rate = 5-ply plain Rs 46 + Rs 3 BF22 add-on)"
                if l["price_category"] in ("PR3", "PR5"):
                    r["conversion_note"] += " (rate = plain + Rs 5 printed add-on)"
            if r["moq_exceeds_monthly_calloff"]:
                r["edge_case_ids"].append("EC-10")
            r["extraction_confidence"] = conf
            r["comparable"] = comparable
            r["hitl_required"] = bool(r["hitl_reasons"])
            r["annual_landed_value_inr"] = round(r["landed_unit_price_inr"] * l["annual_qty"], 0)
            recs.append(r)
    return recs


RECORDS = build_line_records()


def vendor_summary():
    out = {}
    for v in VENDORS:
        vid = v["vendor_id"]
        recs = [r for r in RECORDS if r["vendor_id"] == vid]
        quoted = [r for r in recs if r["quote_status"] != "not_quoted"]
        comp = [r for r in quoted if r["comparable"]]
        val = sum(r["landed_unit_price_inr"] * r["annual_qty"] for r in comp)
        hval = sum(r["historical_price_inr"] * r["annual_qty"] for r in comp)
        out[vid] = {
            "lines_quoted": len(quoted), "lines_missing": [r["line_id"] for r in recs if r["quote_status"] == "not_quoted"],
            "lines_comparable": len(comp),
            "annual_landed_value_comparable_lines_inr": round(val),
            "historical_value_same_lines_inr": round(hval),
            "weighted_variance_vs_historical_pct": round((val - hval) / hval * 100, 1),
        }
    return out


def basket(vids):
    """Lines quoted (comparable) by every vendor in vids; landed annual value per vendor."""
    common = [l["line_id"] for l in LINES if all(
        any(r["vendor_id"] == vid and r["line_id"] == l["line_id"] and r["quote_status"] != "not_quoted" and r["comparable"] for r in RECORDS)
        for vid in vids)]
    vals = {}
    for vid in vids:
        vals[vid] = round(sum(r["landed_unit_price_inr"] * r["annual_qty"] for r in RECORDS if r["vendor_id"] == vid and r["line_id"] in common))
    hist = round(sum(LINE_BY_ID[x]["historical_price_inr"] * LINE_BY_ID[x]["annual_qty"] for x in common))
    return {"lines": common, "line_count": len(common), "annual_landed_value_inr": vals, "historical_value_inr": hist,
            "cheapest": min(vals, key=vals.get)}


def line_winners(vids):
    res = {}
    for l in LINES:
        c = [(r["landed_unit_price_inr"], r["vendor_id"]) for r in RECORDS if r["line_id"] == l["line_id"] and r["vendor_id"] in vids and r["quote_status"] != "not_quoted" and r["comparable"]]
        res[l["line_id"]] = min(c)[1] if c else None
    return res
