# Precision mapping

Currency, decimal, and percent values are stored as an exact canonical decimal string in a Catalyst VarChar column of length 64. Scale is the field decimal places (`decimalplace`, `decimal places`, or `decimal digits`). When the `.ds` omits that property the scale is 2. Extra fractional digits quantize half-away-from-zero, the same rule as the Deluge `round` shim (`218.5` to 0 places is `219`; `-1.5` to 0 places is `-2`).

Creator counts a decimal, percent, or currency value at a maximum of 19 characters, and the minus sign, the digits, and the decimal point all count (https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/understand-max-digits). Decimal points are the maximum digits after the point. Extra digits on submit are invalid, not silently rounded (https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/understand-decimal-points). Reducing the property later “rounds off” stored values, and that help page does not name the rounding mode (https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/set-decimal-points). Import therefore quantizes with the Deluge rule (https://www.zoho.com/deluge/help/functions/number/round.html).

Percent is the number the user types. The % sign is display only, and the stored value is not divided by 100 (https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/understand-percent). Currency display follows the field currency type (`type = INR` and the other ISO 4217 codes). The code is column metadata, not a per-cell value (https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/fields-currency-understand). Decimal, percent, and currency are DECIMAL values in Deluge; a plain number is BIGINT (https://www.zoho.com/deluge/help/creator-field-datatype.html).

Catalyst Data Store has no decimal and no BigDecimal column. The column types are Text, VarChar, Date, DateTime, Int, Double, Boolean, BigInt, Foreign Key, and Encrypted text. Double is binary64 (https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/columns/). This mapping does not use Double for these fields. Address latitude and longitude stay Double with precision 6.

ZCQL compares and orders a varchar as text (`'20.00' <= '100.00'` is false; `'90.00'` sorts after `'1000.00'`). Each `varchar-exact-decimal` field therefore has a Double shadow column (`<Field>__n`, listed below). The runtime, the CSV loader, and the Creator migrator write it next to the varchar; app code never reads it. ZCQL criteria and ORDER BY on the field use the shadow with a bound widened by 10^-scale + |value| * 10^-15, a superset of the exact match. The runtime then keeps only rows that `shim.decimal.cmp` accepts on the exact varchar, re-sorts rows tied on the shadow by the exact value and ROWID, and applies `range from/to` to the exact result. This mapping does not claim a ZCQL decimal cast exists.

Rows with a NULL shadow. ZCQL WHERE is SQL three-valued: a comparison with a NULL shadow is UNKNOWN, NOT UNKNOWN is UNKNOWN, and only TRUE rows come back. A shadow is NULL for a blank value, and for every row stored before the shadow column existed: deploy adds `<Field>__n` to an existing table and does not fill it. So every decimal comparison compiles to `(<bound> OR <shadow> IS NULL)`, NOT of `<`, `<=`, `>`, or `>=` compiles to `(NOT (<bound>) OR <shadow> IS NULL)`, and a comparison deeper under NOT is `(<shadow> IS NOT NULL AND <bound>)`. A NULL-shadow row therefore always reaches the exact check on the varchar, where a blank is not `< 5` and so is in `NOT (x < 5)`. A decimal sort with a range reads the NULL-shadow rows in one more query and places them by their exact value. The cost is reads, not correctness: every NULL-shadow row on the table is read by every decimal criteria on it. In a test with 6000 rows, `Amount <= 100` (101 matches) reads 101 rows with no NULL shadows, 690 rows when 10% are blank or stale, and all 6000 (21 queries) before a backfill; a windowed decimal sort takes 2 queries instead of 1. When deploy creates a shadow column on a table that already has rows, its post-deploy steps name the table and row count, and `c2c migrate-data --source-csv` warns when a written table still has rows with a value and a NULL shadow. `c2c deploy <app> --project <id> --org <org> --backfill-shadows --confirm` fills them: it reads NULL-shadow rows by ROWID keyset, 200 at a time, writes the binary64 of the varchar, pauses 250 ms between pages, and waits Retry-After on a 429 (it stops with the counts so far when that wait is over 60 s, or after five 429s in a row). Blanks and non-numbers stay NULL. Re-running it is safe.

A form with two or more inline subforms is NoSQL. Its precision fields, including fields nested in those subforms, are `embedded-exact-decimal` strings inside the document, not JSON numbers, and the Data Store table is not created. A single inline subform’s fields are real child-table columns (`varchar-exact-decimal`). A nested subform the schema does not expand is `embedded-exact-decimal`. CSV import still skips NoSQL forms; those fields are listed here anyway.

Measured fields: 440

## Fields

App_01 / Form_1.Field_1 percent places 2 → varchar-exact-decimal + shadow Field_1__n Double
App_01 / Form_2.Field_2 percent places 2 → varchar-exact-decimal + shadow Field_2__n Double
App_01 / Form_3.Field_3 decimal places 2 → varchar-exact-decimal + shadow Field_3__n Double
App_02 / Form_4.Field_4 currency places 2 currency USD → varchar-exact-decimal + shadow Field_4__n Double
App_02 / Form_5.Field_5 currency places 2 currency USD → varchar-exact-decimal + shadow Field_5__n Double
App_02 / Form_6.Field_6 currency places 2 currency USD → embedded-exact-decimal
App_02 / Form_6.Field_7 currency places 2 currency USD → embedded-exact-decimal
App_02 / Form_6.Field_8 currency places 2 currency USD → embedded-exact-decimal
App_02 / Form_6.Field_9 currency places 2 currency USD → embedded-exact-decimal
App_02 / Form_6.Field_10 currency places 2 currency USD → embedded-exact-decimal
App_02 / Form_6.Field_11 currency places 2 currency USD → embedded-exact-decimal
App_02 / Form_6.Field_12 decimal places 2 → embedded-exact-decimal
App_03 / Form_7.Field_13 decimal places 2 → varchar-exact-decimal + shadow Field_13__n Double
App_03 / Form_7.Field_14 decimal places 2 → varchar-exact-decimal + shadow Field_14__n Double
App_03 / Form_8.Field_15 decimal places 2 → varchar-exact-decimal + shadow Field_15__n Double
App_03 / Form_8.Field_16 decimal places 2 → varchar-exact-decimal + shadow Field_16__n Double
App_03 / Form_8.Field_17 decimal places 2 → varchar-exact-decimal + shadow Field_17__n Double
App_03 / Form_8.Field_18 percent places 2 → varchar-exact-decimal + shadow Field_18__n Double
App_03 / Form_8.Field_19 decimal places 2 → varchar-exact-decimal + shadow Field_19__n Double
App_03 / Form_8.Field_20 decimal places 2 → varchar-exact-decimal + shadow Field_20__n Double
App_03 / Form_8.Field_21 decimal places 2 → varchar-exact-decimal + shadow Field_21__n Double
App_03 / Form_8.Field_22 decimal places 2 → varchar-exact-decimal + shadow Field_22__n Double
App_03 / Form_8.Field_23 decimal places 2 → varchar-exact-decimal + shadow Field_23__n Double
App_03 / Form_9.Field_24 decimal places 6 → varchar-exact-decimal + shadow Field_24__n Double
App_03 / Form_10.Field_25 decimal places 2 → varchar-exact-decimal + shadow Field_25__n Double
App_03 / Form_11.Field_26 decimal places 2 → varchar-exact-decimal + shadow Field_26__n Double
App_03 / Form_11.Field_27 decimal places 2 → varchar-exact-decimal + shadow Field_27__n Double
App_03 / Form_12.Field_28 currency places 2 currency INR → varchar-exact-decimal + shadow Field_28__n Double
App_03 / Form_13.Field_29 decimal places 2 → varchar-exact-decimal + shadow Field_29__n Double
App_03 / Form_13.Field_30 decimal places 2 → varchar-exact-decimal + shadow Field_30__n Double
App_03 / Form_13.Field_31 decimal places 2 → varchar-exact-decimal + shadow Field_31__n Double
App_03 / Form_13.Field_32 decimal places 2 → varchar-exact-decimal + shadow Field_32__n Double
App_03 / Form_13.Field_33 decimal places 2 → varchar-exact-decimal + shadow Field_33__n Double
App_03 / Form_14.Field_34 decimal places 2 → varchar-exact-decimal + shadow Field_34__n Double
App_03 / Form_14.Field_35 decimal places 2 → varchar-exact-decimal + shadow Field_35__n Double
App_03 / Form_14.Field_36 decimal places 2 → varchar-exact-decimal + shadow Field_36__n Double
App_03 / Form_14.Field_37 percent places 2 → varchar-exact-decimal + shadow Field_37__n Double
App_03 / Form_14.Field_38 decimal places 2 → varchar-exact-decimal + shadow Field_38__n Double
App_03 / Form_14.Field_39 decimal places 2 → varchar-exact-decimal + shadow Field_39__n Double
App_03 / Form_14.Field_40 decimal places 2 → varchar-exact-decimal + shadow Field_40__n Double
App_03 / Form_14.Field_41 decimal places 2 → varchar-exact-decimal + shadow Field_41__n Double
App_03 / Form_14.Field_42 decimal places 2 → varchar-exact-decimal + shadow Field_42__n Double
App_03 / Form_14.Field_43 decimal places 2 → varchar-exact-decimal + shadow Field_43__n Double
App_03 / Form_14.Field_44 decimal places 2 → varchar-exact-decimal + shadow Field_44__n Double
App_03 / Form_14.Field_45 decimal places 2 → varchar-exact-decimal + shadow Field_45__n Double
App_03 / Form_15.Field_46 percent places 2 → varchar-exact-decimal + shadow Field_46__n Double
App_03 / Form_16.Field_47 decimal places 2 → varchar-exact-decimal + shadow Field_47__n Double
App_03 / Form_16.Field_48 decimal places 2 → varchar-exact-decimal + shadow Field_48__n Double
App_03 / Form_16.Field_49 decimal places 2 → varchar-exact-decimal + shadow Field_49__n Double
App_03 / Form_16.Field_50 decimal places 2 → varchar-exact-decimal + shadow Field_50__n Double
App_03 / Form_17.Field_51 decimal places 2 → varchar-exact-decimal + shadow Field_51__n Double
App_03 / Form_17.Field_52 decimal places 2 → varchar-exact-decimal + shadow Field_52__n Double
App_03 / Form_18.Field_53 decimal places 2 → varchar-exact-decimal + shadow Field_53__n Double
App_03 / Form_18.Field_54 decimal places 2 → varchar-exact-decimal + shadow Field_54__n Double
App_03 / Form_18.Field_55 decimal places 2 → varchar-exact-decimal + shadow Field_55__n Double
App_03 / Form_18.Field_56 decimal places 2 → varchar-exact-decimal + shadow Field_56__n Double
App_03 / Form_19.Field_57 decimal places 2 → varchar-exact-decimal + shadow Field_57__n Double
App_03 / Form_20.Field_58 decimal places 2 → varchar-exact-decimal + shadow Field_58__n Double
App_03 / Form_21.Field_59 decimal places 2 → varchar-exact-decimal + shadow Field_59__n Double
App_03 / Form_22.Field_60 percent places 2 → varchar-exact-decimal + shadow Field_60__n Double
App_03 / Form_22.Field_61 decimal places 2 → varchar-exact-decimal + shadow Field_61__n Double
App_04 / Form_23.Field_62 currency places 2 currency INR → varchar-exact-decimal + shadow Field_62__n Double
App_04 / Form_23.Field_63 currency places 2 currency INR → varchar-exact-decimal + shadow Field_63__n Double
App_04 / Form_24.Field_64 percent places 2 → varchar-exact-decimal + shadow Field_64__n Double
App_04 / Form_25.Field_65 currency places 2 currency INR → varchar-exact-decimal + shadow Field_65__n Double
App_04 / Form_25.Field_66 currency places 2 currency INR → varchar-exact-decimal + shadow Field_66__n Double
App_04 / Form_26.Field_67 currency places 2 currency INR → varchar-exact-decimal + shadow Field_67__n Double
App_04 / Form_26.Field_68 currency places 2 currency INR → varchar-exact-decimal + shadow Field_68__n Double
App_04 / Form_26.Field_69 currency places 2 currency INR → varchar-exact-decimal + shadow Field_69__n Double
App_05 / Form_27.Field_70 currency places 2 currency INR → varchar-exact-decimal + shadow Field_70__n Double
App_05 / Form_27.Field_71 currency places 2 currency INR → varchar-exact-decimal + shadow Field_71__n Double
App_05 / Form_28.Field_72 currency places 2 currency INR → varchar-exact-decimal + shadow Field_72__n Double
App_05 / Form_29.Field_73 currency places 2 currency INR → varchar-exact-decimal + shadow Field_73__n Double
App_06 / Form_30.Field_74 currency places 2 currency INR → varchar-exact-decimal + shadow Field_74__n Double
App_06 / Form_30.Field_75 decimal places 2 → varchar-exact-decimal + shadow Field_75__n Double
App_06 / Form_31.Field_76 currency places 2 currency INR → varchar-exact-decimal + shadow Field_76__n Double
App_07 / Form_32.Field_77 currency places 2 currency INR → varchar-exact-decimal + shadow Field_77__n Double
App_07 / Form_33.Field_78 currency places 2 currency INR → varchar-exact-decimal + shadow Field_78__n Double
App_07 / Form_34.Field_79 percent places 2 → varchar-exact-decimal + shadow Field_79__n Double
App_07 / Form_34.Field_80 currency places 2 currency INR → varchar-exact-decimal + shadow Field_80__n Double
App_07 / Form_34.Field_81 currency places 2 currency INR → varchar-exact-decimal + shadow Field_81__n Double
App_07 / Form_34.Field_82 currency places 2 currency INR → varchar-exact-decimal + shadow Field_82__n Double
App_07 / Form_35.Field_83 currency places 2 currency INR → varchar-exact-decimal + shadow Field_83__n Double
App_07 / Form_36.Field_84 percent places 2 → varchar-exact-decimal + shadow Field_84__n Double
App_07 / Form_36.Field_85 currency places 2 currency INR → varchar-exact-decimal + shadow Field_85__n Double
App_07 / Form_37.Field_86 percent places 2 → varchar-exact-decimal + shadow Field_86__n Double
App_07 / Form_38.Field_87 currency places 2 currency INR → varchar-exact-decimal + shadow Field_87__n Double
App_07 / Form_38.Field_88 currency places 2 currency INR → varchar-exact-decimal + shadow Field_88__n Double
App_07 / Form_39.Field_89 currency places 2 currency INR → varchar-exact-decimal + shadow Field_89__n Double
App_07 / Form_39.Field_90 percent places 2 → varchar-exact-decimal + shadow Field_90__n Double
App_07 / Form_39.Field_91 percent places 2 → varchar-exact-decimal + shadow Field_91__n Double
App_07 / Form_39.Field_92 currency places 2 currency INR → varchar-exact-decimal + shadow Field_92__n Double
App_07 / Form_40.Field_93 currency places 2 currency INR → varchar-exact-decimal + shadow Field_93__n Double
App_07 / Form_40.Field_94 currency places 2 currency INR → varchar-exact-decimal + shadow Field_94__n Double
App_07 / Form_40.Field_95 currency places 2 currency INR → varchar-exact-decimal + shadow Field_95__n Double
App_07 / Form_40.Field_96 percent places 2 → varchar-exact-decimal + shadow Field_96__n Double
App_07 / Form_40.Field_97 percent places 2 → varchar-exact-decimal + shadow Field_97__n Double
App_07 / Form_40.Field_98 currency places 2 currency INR → varchar-exact-decimal + shadow Field_98__n Double
App_07 / Form_41.Field_99 currency places 2 currency INR → varchar-exact-decimal + shadow Field_99__n Double
App_07 / Form_41.Field_100 currency places 2 currency INR → varchar-exact-decimal + shadow Field_100__n Double
App_08 / Form_42.Field_101 decimal places 2 → varchar-exact-decimal + shadow Field_101__n Double
App_08 / Form_42.Field_102 decimal places 2 → varchar-exact-decimal + shadow Field_102__n Double
App_08 / Form_42.Field_103 decimal places 2 → varchar-exact-decimal + shadow Field_103__n Double
App_08 / Form_42.Field_104 decimal places 2 → varchar-exact-decimal + shadow Field_104__n Double
App_08 / Form_42.Field_105 decimal places 2 → varchar-exact-decimal + shadow Field_105__n Double
App_08 / Form_42.Field_106 decimal places 2 → varchar-exact-decimal + shadow Field_106__n Double
App_09 / Form_43.Field_107 currency places 2 currency INR → varchar-exact-decimal + shadow Field_107__n Double
App_09 / Form_43.Field_108 currency places 2 currency INR → varchar-exact-decimal + shadow Field_108__n Double
App_09 / Form_43.Field_109 currency places 2 currency INR → varchar-exact-decimal + shadow Field_109__n Double
App_09 / Form_43.Field_110 currency places 2 currency INR → varchar-exact-decimal + shadow Field_110__n Double
App_09 / Form_44.Field_111 currency places 2 currency INR → varchar-exact-decimal + shadow Field_111__n Double
App_09 / Form_45.Field_112 currency places 2 currency INR → varchar-exact-decimal + shadow Field_112__n Double
App_09 / Form_45.Field_113 currency places 2 currency INR → varchar-exact-decimal + shadow Field_113__n Double
App_09 / Form_45.Field_114 currency places 2 currency INR → varchar-exact-decimal + shadow Field_114__n Double
App_09 / Form_45.Field_115 currency places 2 currency INR → varchar-exact-decimal + shadow Field_115__n Double
App_09 / Form_45.Field_116 percent places 2 → varchar-exact-decimal + shadow Field_116__n Double
App_09 / Form_45.Field_117 currency places 2 currency INR → varchar-exact-decimal + shadow Field_117__n Double
App_09 / Form_45.Field_118 currency places 2 currency INR → varchar-exact-decimal + shadow Field_118__n Double
App_09 / Form_45.Field_119 currency places 2 currency INR → varchar-exact-decimal + shadow Field_119__n Double
App_09 / Form_45.Field_120 currency places 2 currency INR → varchar-exact-decimal + shadow Field_120__n Double
App_09 / Form_46.Field_121 currency places 2 currency INR → varchar-exact-decimal + shadow Field_121__n Double
App_09 / Form_46.Field_122 currency places 2 currency INR → varchar-exact-decimal + shadow Field_122__n Double
App_09 / Form_46.Field_123 percent places 2 → varchar-exact-decimal + shadow Field_123__n Double
App_09 / Form_46.Field_124 currency places 2 currency INR → varchar-exact-decimal + shadow Field_124__n Double
App_09 / Form_46.Field_125 currency places 2 currency INR → varchar-exact-decimal + shadow Field_125__n Double
App_09 / Form_46.Field_126 currency places 2 currency INR → varchar-exact-decimal + shadow Field_126__n Double
App_09 / Form_46.Field_127 currency places 2 currency INR → varchar-exact-decimal + shadow Field_127__n Double
App_09 / Form_47.Field_128 currency places 2 currency INR → varchar-exact-decimal + shadow Field_128__n Double
App_09 / Form_47.Field_129 currency places 2 currency INR → varchar-exact-decimal + shadow Field_129__n Double
App_10 / Form_48.Field_130 currency places 2 currency INR → varchar-exact-decimal + shadow Field_130__n Double
App_10 / Form_49.Field_131 currency places 2 currency INR → varchar-exact-decimal + shadow Field_131__n Double
App_10 / Form_49.Field_132 currency places 2 currency INR → varchar-exact-decimal + shadow Field_132__n Double
App_10 / Form_50.Field_133 decimal places 2 → varchar-exact-decimal + shadow Field_133__n Double
App_11 / Form_51.Field_134 decimal places 2 → varchar-exact-decimal + shadow Field_134__n Double
App_11 / Form_52.Field_135 decimal places 2 → varchar-exact-decimal + shadow Field_135__n Double
App_11 / Form_52.Field_136 decimal places 2 → varchar-exact-decimal + shadow Field_136__n Double
App_11 / Form_52.Field_137 percent places 2 → varchar-exact-decimal + shadow Field_137__n Double
App_11 / Form_52.Field_138 decimal places 2 → varchar-exact-decimal + shadow Field_138__n Double
App_11 / Form_52.Field_139 decimal places 2 → varchar-exact-decimal + shadow Field_139__n Double
App_11 / Form_52.Field_140 decimal places 2 → varchar-exact-decimal + shadow Field_140__n Double
App_11 / Form_52.Field_141 decimal places 2 → varchar-exact-decimal + shadow Field_141__n Double
App_11 / Form_52.Field_142 decimal places 2 → varchar-exact-decimal + shadow Field_142__n Double
App_11 / Form_53.Field_143 decimal places 2 → varchar-exact-decimal + shadow Field_143__n Double
App_11 / Form_54.Field_144 decimal places 2 → varchar-exact-decimal + shadow Field_144__n Double
App_11 / Form_55.Field_145 decimal places 2 → varchar-exact-decimal + shadow Field_145__n Double
App_11 / Form_55.Field_146 decimal places 2 → varchar-exact-decimal + shadow Field_146__n Double
App_11 / Form_55.Field_147 percent places 2 → varchar-exact-decimal + shadow Field_147__n Double
App_11 / Form_55.Field_148 decimal places 2 → varchar-exact-decimal + shadow Field_148__n Double
App_11 / Form_55.Field_149 decimal places 2 → varchar-exact-decimal + shadow Field_149__n Double
App_11 / Form_55.Field_150 decimal places 2 → varchar-exact-decimal + shadow Field_150__n Double
App_11 / Form_55.Field_151 decimal places 2 → varchar-exact-decimal + shadow Field_151__n Double
App_11 / Form_55.Field_152 decimal places 2 → varchar-exact-decimal + shadow Field_152__n Double
App_11 / Form_55.Field_153 decimal places 2 → varchar-exact-decimal + shadow Field_153__n Double
App_11 / Form_55.Field_154 decimal places 2 → varchar-exact-decimal + shadow Field_154__n Double
App_11 / Form_55.Field_155 decimal places 2 → varchar-exact-decimal + shadow Field_155__n Double
App_12 / Form_56.Field_156 percent places 2 → varchar-exact-decimal + shadow Field_156__n Double
App_12 / Form_57.Field_157 currency places 2 currency INR → varchar-exact-decimal + shadow Field_157__n Double
App_12 / Form_57.Field_158 currency places 2 currency INR → varchar-exact-decimal + shadow Field_158__n Double
App_13 / Form_58.Field_159 percent places 2 → embedded-exact-decimal
App_13 / Form_58.Field_160 currency places 2 currency INR → embedded-exact-decimal
App_14 / Form_59.Field_161 currency places 2 currency INR → varchar-exact-decimal + shadow Field_161__n Double
App_14 / Form_60.Field_162 currency places 2 currency INR → varchar-exact-decimal + shadow Field_162__n Double
App_14 / Form_60.Field_163 currency places 2 currency INR → varchar-exact-decimal + shadow Field_163__n Double
App_15 / Form_61.Field_164 currency places 2 currency INR → varchar-exact-decimal + shadow Field_164__n Double
App_15 / Form_62.Field_165 currency places 2 currency INR → varchar-exact-decimal + shadow Field_165__n Double
App_15 / Form_62.Field_166 currency places 2 currency INR → varchar-exact-decimal + shadow Field_166__n Double
App_15 / Form_63.Field_167 currency places 2 currency INR → varchar-exact-decimal + shadow Field_167__n Double
App_15 / Form_64.Field_168 currency places 2 currency INR → varchar-exact-decimal + shadow Field_168__n Double
App_15 / Form_65.Field_169 currency places 2 currency INR → varchar-exact-decimal + shadow Field_169__n Double
App_15 / Form_66.Field_170 currency places 2 currency INR → varchar-exact-decimal + shadow Field_170__n Double
App_16 / Form_67.Field_171 currency places 2 currency INR → varchar-exact-decimal + shadow Field_171__n Double
App_16 / Form_67.Field_172 currency places 2 currency INR → varchar-exact-decimal + shadow Field_172__n Double
App_16 / Form_67.Field_173 percent places 2 → varchar-exact-decimal + shadow Field_173__n Double
App_16 / Form_67.Field_174 currency places 2 currency INR → varchar-exact-decimal + shadow Field_174__n Double
App_17 / Form_68.Field_175 currency places 2 currency INR → varchar-exact-decimal + shadow Field_175__n Double
App_17 / Form_69.Field_176 currency places 2 currency INR → varchar-exact-decimal + shadow Field_176__n Double
App_17 / Form_69.Field_177 currency places 2 currency INR → varchar-exact-decimal + shadow Field_177__n Double
App_17 / Form_69.Field_178 currency places 2 currency INR → varchar-exact-decimal + shadow Field_178__n Double
App_17 / Form_69.Field_179 percent places 2 → varchar-exact-decimal + shadow Field_179__n Double
App_17 / Form_69.Field_180 currency places 2 currency INR → varchar-exact-decimal + shadow Field_180__n Double
App_18 / Form_70.Field_181 decimal places 2 → varchar-exact-decimal + shadow Field_181__n Double
App_18 / Form_71.Field_182 decimal places 2 → varchar-exact-decimal + shadow Field_182__n Double
App_18 / Form_71.Field_183 decimal places 2 → varchar-exact-decimal + shadow Field_183__n Double
App_18 / Form_72.Field_184 decimal places 2 → varchar-exact-decimal + shadow Field_184__n Double
App_18 / Form_72.Field_185 decimal places 2 → varchar-exact-decimal + shadow Field_185__n Double
App_18 / Form_73.Field_186 decimal places 2 → varchar-exact-decimal + shadow Field_186__n Double
App_19 / Form_74.Field_187 currency places 2 currency USD → varchar-exact-decimal + shadow Field_187__n Double
App_19 / Form_74.Field_188 currency places 2 currency USD → varchar-exact-decimal + shadow Field_188__n Double
App_19 / Form_75.Field_189 currency places 2 currency USD → varchar-exact-decimal + shadow Field_189__n Double
App_19 / Form_75.Field_190 currency places 2 currency USD → varchar-exact-decimal + shadow Field_190__n Double
App_19 / Form_75.Field_191 currency places 2 currency USD → varchar-exact-decimal + shadow Field_191__n Double
App_19 / Form_75.Field_192 currency places 2 currency USD → varchar-exact-decimal + shadow Field_192__n Double
App_19 / Form_75.Field_193 currency places 2 currency USD → varchar-exact-decimal + shadow Field_193__n Double
App_19 / Form_76.Field_194 currency places 2 currency USD → varchar-exact-decimal + shadow Field_194__n Double
App_19 / Form_76.Field_195 currency places 2 currency USD → varchar-exact-decimal + shadow Field_195__n Double
App_19 / Form_76.Field_196 currency places 2 currency USD → varchar-exact-decimal + shadow Field_196__n Double
App_19 / Form_76.Field_197 currency places 2 currency USD → varchar-exact-decimal + shadow Field_197__n Double
App_19 / Form_76.Field_198 currency places 2 currency USD → varchar-exact-decimal + shadow Field_198__n Double
App_19 / Form_76.Field_199 currency places 2 currency USD → varchar-exact-decimal + shadow Field_199__n Double
App_19 / Form_76.Field_200 currency places 2 currency USD → varchar-exact-decimal + shadow Field_200__n Double
App_19 / Form_77.Field_201 currency places 2 currency USD → varchar-exact-decimal + shadow Field_201__n Double
App_19 / Form_78.Field_202 currency places 2 currency USD → varchar-exact-decimal + shadow Field_202__n Double
App_19 / Form_78.Field_203 currency places 2 currency USD → varchar-exact-decimal + shadow Field_203__n Double
App_19 / Form_78.Field_204 currency places 2 currency USD → varchar-exact-decimal + shadow Field_204__n Double
App_19 / Form_78.Field_205 currency places 2 currency USD → varchar-exact-decimal + shadow Field_205__n Double
App_19 / Form_78.Field_206 currency places 2 currency USD → varchar-exact-decimal + shadow Field_206__n Double
App_19 / Form_78.Field_207 currency places 2 currency USD → varchar-exact-decimal + shadow Field_207__n Double
App_19 / Form_78.Field_208 currency places 2 currency USD → varchar-exact-decimal + shadow Field_208__n Double
App_19 / Form_78.Field_209 currency places 2 currency USD → varchar-exact-decimal + shadow Field_209__n Double
App_19 / Form_78.Field_210 currency places 2 currency USD → varchar-exact-decimal + shadow Field_210__n Double
App_19 / Form_79.Field_211 currency places 2 currency USD → varchar-exact-decimal + shadow Field_211__n Double
App_19 / Form_79.Field_212 currency places 2 currency USD → varchar-exact-decimal + shadow Field_212__n Double
App_19 / Form_80.Field_213 percent places 2 → varchar-exact-decimal + shadow Field_213__n Double
App_19 / Form_81.Field_214 currency places 2 currency USD → varchar-exact-decimal + shadow Field_214__n Double
App_19 / Form_81.Field_215 currency places 2 currency USD → varchar-exact-decimal + shadow Field_215__n Double
App_19 / Form_81.Field_216 currency places 2 currency USD → varchar-exact-decimal + shadow Field_216__n Double
App_19 / Form_82.Field_217 currency places 2 currency USD → varchar-exact-decimal + shadow Field_217__n Double
App_19 / Form_82.Field_218 currency places 2 currency USD → varchar-exact-decimal + shadow Field_218__n Double
App_19 / Form_83.Field_219 currency places 2 currency USD → varchar-exact-decimal + shadow Field_219__n Double
App_19 / Form_83.Field_220 currency places 2 currency USD → varchar-exact-decimal + shadow Field_220__n Double
App_19 / Form_83.Field_221 currency places 2 currency USD → varchar-exact-decimal + shadow Field_221__n Double
App_19 / Form_83.Field_222 currency places 2 currency USD → varchar-exact-decimal + shadow Field_222__n Double
App_19 / Form_84.Field_223 currency places 2 currency USD → varchar-exact-decimal + shadow Field_223__n Double
App_19 / Form_84.Field_224 currency places 2 currency USD → varchar-exact-decimal + shadow Field_224__n Double
App_19 / Form_84.Field_225 currency places 2 currency USD → varchar-exact-decimal + shadow Field_225__n Double
App_19 / Form_85.Field_226 currency places 2 currency USD → varchar-exact-decimal + shadow Field_226__n Double
App_19 / Form_85.Field_227 currency places 2 currency USD → varchar-exact-decimal + shadow Field_227__n Double
App_19 / Form_85.Field_228 currency places 2 currency USD → varchar-exact-decimal + shadow Field_228__n Double
App_19 / Form_85.Field_229 currency places 2 currency USD → varchar-exact-decimal + shadow Field_229__n Double
App_19 / Form_85.Field_230 currency places 2 currency USD → varchar-exact-decimal + shadow Field_230__n Double
App_20 / Form_86.Field_231 percent places 2 → varchar-exact-decimal + shadow Field_231__n Double
App_20 / Form_87.Field_232 currency places 2 currency INR → varchar-exact-decimal + shadow Field_232__n Double
App_20 / Form_87.Field_233 currency places 2 currency INR → varchar-exact-decimal + shadow Field_233__n Double
App_21 / Form_88.Field_234 decimal places 4 → varchar-exact-decimal + shadow Field_234__n Double
App_22 / Form_89.Field_235 currency places 2 currency USD → varchar-exact-decimal + shadow Field_235__n Double
App_22 / Form_90.Field_236 currency places 2 currency USD → varchar-exact-decimal + shadow Field_236__n Double
App_22 / Form_90.Field_237 currency places 2 currency USD → varchar-exact-decimal + shadow Field_237__n Double
App_22 / Form_90.Field_238 currency places 2 currency USD → varchar-exact-decimal + shadow Field_238__n Double
App_22 / Form_90.Field_239 currency places 2 currency USD → varchar-exact-decimal + shadow Field_239__n Double
App_22 / Form_91.Field_240 currency places 2 currency USD → varchar-exact-decimal + shadow Field_240__n Double
App_22 / Form_91.Field_241 currency places 2 currency USD → varchar-exact-decimal + shadow Field_241__n Double
App_22 / Form_92.Field_242 currency places 2 currency USD → varchar-exact-decimal + shadow Field_242__n Double
App_22 / Form_93.Field_243 percent places 2 → varchar-exact-decimal + shadow Field_243__n Double
App_22 / Form_94.Field_244 currency places 2 currency USD → varchar-exact-decimal + shadow Field_244__n Double
App_22 / Form_94.Field_245 currency places 2 currency USD → varchar-exact-decimal + shadow Field_245__n Double
App_22 / Form_94.Field_246 currency places 2 currency USD → varchar-exact-decimal + shadow Field_246__n Double
App_22 / Form_95.Field_247 currency places 2 currency USD → varchar-exact-decimal + shadow Field_247__n Double
App_22 / Form_95.Field_248 currency places 2 currency USD → varchar-exact-decimal + shadow Field_248__n Double
App_22 / Form_95.Field_249 currency places 2 currency USD → varchar-exact-decimal + shadow Field_249__n Double
App_22 / Form_95.Field_250 currency places 2 currency USD → varchar-exact-decimal + shadow Field_250__n Double
App_22 / Form_95.Field_251 currency places 2 currency USD → varchar-exact-decimal + shadow Field_251__n Double
App_23 / Form_96.Field_252 currency places 2 currency INR → varchar-exact-decimal + shadow Field_252__n Double
App_24 / Form_97.Field_253 decimal places 1 → varchar-exact-decimal + shadow Field_253__n Double
App_24 / Form_98.Field_254 decimal places 1 → varchar-exact-decimal + shadow Field_254__n Double
App_24 / Form_98.Field_255 decimal places 1 → varchar-exact-decimal + shadow Field_255__n Double
App_24 / Form_98.Field_256 decimal places 1 → varchar-exact-decimal + shadow Field_256__n Double
App_25 / Form_99.Field_257 decimal places 2 → varchar-exact-decimal + shadow Field_257__n Double
App_25 / Form_99.Field_258 decimal places 2 → varchar-exact-decimal + shadow Field_258__n Double
App_25 / Form_99.Field_259 decimal places 2 → varchar-exact-decimal + shadow Field_259__n Double
App_25 / Form_100.Field_260 decimal places 2 → varchar-exact-decimal + shadow Field_260__n Double
App_25 / Form_100.Field_261 decimal places 2 → varchar-exact-decimal + shadow Field_261__n Double
App_26 / Form_101.Field_262 currency places 2 currency INR → varchar-exact-decimal + shadow Field_262__n Double
App_26 / Form_101.Field_263 currency places 2 currency INR → varchar-exact-decimal + shadow Field_263__n Double
App_26 / Form_101.Field_264 currency places 2 currency INR → varchar-exact-decimal + shadow Field_264__n Double
App_26 / Form_101.Field_265 currency places 2 currency INR → varchar-exact-decimal + shadow Field_265__n Double
App_26 / Form_102.Field_266 currency places 2 currency INR → varchar-exact-decimal + shadow Field_266__n Double
App_26 / Form_102.Field_267 currency places 2 currency INR → varchar-exact-decimal + shadow Field_267__n Double
App_27 / Form_103.Field_268 decimal places 2 → varchar-exact-decimal + shadow Field_268__n Double
App_27 / Form_103.Field_269 decimal places 2 → varchar-exact-decimal + shadow Field_269__n Double
App_27 / Form_103.Field_270 percent places 2 → varchar-exact-decimal + shadow Field_270__n Double
App_27 / Form_103.Field_271 decimal places 2 → varchar-exact-decimal + shadow Field_271__n Double
App_27 / Form_104.Field_272 decimal places 2 → varchar-exact-decimal + shadow Field_272__n Double
App_27 / Form_105.Field_273 decimal places 2 → varchar-exact-decimal + shadow Field_273__n Double
App_27 / Form_105.Field_274 decimal places 2 → varchar-exact-decimal + shadow Field_274__n Double
App_27 / Form_105.Field_275 decimal places 2 → varchar-exact-decimal + shadow Field_275__n Double
App_28 / Form_106.Field_276 currency places 2 currency INR → varchar-exact-decimal + shadow Field_276__n Double
App_28 / Form_106.Field_277 percent places 2 → varchar-exact-decimal + shadow Field_277__n Double
App_28 / Form_106.Field_278 currency places 2 currency INR → varchar-exact-decimal + shadow Field_278__n Double
App_28 / Form_107.Field_279 currency places 2 currency INR → varchar-exact-decimal + shadow Field_279__n Double
App_28 / Form_108.Field_280 currency places 2 currency INR → varchar-exact-decimal + shadow Field_280__n Double
App_28 / Form_108.Field_281 percent places 2 → varchar-exact-decimal + shadow Field_281__n Double
App_28 / Form_108.Field_282 currency places 2 currency INR → varchar-exact-decimal + shadow Field_282__n Double
App_28 / Form_109.Field_283 currency places 2 currency INR → varchar-exact-decimal + shadow Field_283__n Double
App_28 / Form_109.Field_284 currency places 2 currency INR → varchar-exact-decimal + shadow Field_284__n Double
App_28 / Form_110.Field_285 currency places 2 currency INR → varchar-exact-decimal + shadow Field_285__n Double
App_28 / Form_110.Field_286 currency places 2 currency INR → varchar-exact-decimal + shadow Field_286__n Double
App_28 / Form_110.Field_287 currency places 2 currency INR → varchar-exact-decimal + shadow Field_287__n Double
App_29 / Form_111.Field_288 currency places 2 currency USD → varchar-exact-decimal + shadow Field_288__n Double
App_29 / Form_111.Field_289 currency places 2 currency USD → varchar-exact-decimal + shadow Field_289__n Double
App_29 / Form_112.Field_290 currency places 2 currency USD → varchar-exact-decimal + shadow Field_290__n Double
App_29 / Form_113.Field_291 currency places 2 currency USD → varchar-exact-decimal + shadow Field_291__n Double
App_29 / Form_114.Field_292 currency places 2 currency USD → varchar-exact-decimal + shadow Field_292__n Double
App_29 / Form_115.Field_293 currency places 2 currency USD → varchar-exact-decimal + shadow Field_293__n Double
App_29 / Form_116.Field_294 currency places 2 currency USD → varchar-exact-decimal + shadow Field_294__n Double
App_30 / Form_117.Field_295 currency places 2 currency INR → varchar-exact-decimal + shadow Field_295__n Double
App_30 / Form_118.Field_296 currency places 2 currency INR → varchar-exact-decimal + shadow Field_296__n Double
App_30 / Form_118.Field_297 percent places 2 → varchar-exact-decimal + shadow Field_297__n Double
App_30 / Form_119.Field_298 currency places 2 currency INR → varchar-exact-decimal + shadow Field_298__n Double
App_30 / Form_119.Field_299 percent places 2 → varchar-exact-decimal + shadow Field_299__n Double
App_30 / Form_119.Field_300 currency places 2 currency INR → varchar-exact-decimal + shadow Field_300__n Double
App_30 / Form_119.Field_301 currency places 2 currency INR → varchar-exact-decimal + shadow Field_301__n Double
App_30 / Form_119.Field_302 percent places 2 → varchar-exact-decimal + shadow Field_302__n Double
App_30 / Form_119.Field_303 percent places 2 → varchar-exact-decimal + shadow Field_303__n Double
App_30 / Form_119.Field_304 currency places 2 currency INR → varchar-exact-decimal + shadow Field_304__n Double
App_30 / Form_119.Field_305 currency places 2 currency INR → varchar-exact-decimal + shadow Field_305__n Double
App_30 / Form_120.Field_306 currency places 2 currency INR → varchar-exact-decimal + shadow Field_306__n Double
App_30 / Form_120.Field_307 currency places 2 currency INR → varchar-exact-decimal + shadow Field_307__n Double
App_30 / Form_121.Field_308 currency places 2 currency INR → varchar-exact-decimal + shadow Field_308__n Double
App_30 / Form_121.Field_309 currency places 2 currency INR → varchar-exact-decimal + shadow Field_309__n Double
App_31 / Form_122.Field_310 decimal places 2 → varchar-exact-decimal + shadow Field_310__n Double
App_31 / Form_122.Field_311 currency places 1 currency USD → varchar-exact-decimal + shadow Field_311__n Double
App_31 / Form_123.Field_312 decimal places 2 → varchar-exact-decimal + shadow Field_312__n Double
App_31 / Form_123.Field_313 decimal places 1 → varchar-exact-decimal + shadow Field_313__n Double
App_31 / Form_123.Field_314 currency places 2 currency INR → varchar-exact-decimal + shadow Field_314__n Double
App_31 / Form_124.Field_315 decimal places 2 → varchar-exact-decimal + shadow Field_315__n Double
App_31 / Form_124.Field_316 currency places 2 currency INR → varchar-exact-decimal + shadow Field_316__n Double
App_31 / Form_125.Field_317 decimal places 2 → varchar-exact-decimal + shadow Field_317__n Double
App_31 / Form_126.Field_318 decimal places 1 → varchar-exact-decimal + shadow Field_318__n Double
App_31 / Form_127.Field_319 currency places 2 currency INR → varchar-exact-decimal + shadow Field_319__n Double
App_31 / Form_128.Field_320 decimal places 2 → varchar-exact-decimal + shadow Field_320__n Double
App_32 / Form_129.Field_321 decimal places 2 → varchar-exact-decimal + shadow Field_321__n Double
App_33 / Form_130.Field_322 currency places 2 currency INR → varchar-exact-decimal + shadow Field_322__n Double
App_33 / Form_131.Field_323 currency places 2 currency INR → varchar-exact-decimal + shadow Field_323__n Double
App_33 / Form_131.Field_324 currency places 2 currency INR → varchar-exact-decimal + shadow Field_324__n Double
App_33 / Form_131.Field_325 percent places 2 → varchar-exact-decimal + shadow Field_325__n Double
App_33 / Form_131.Field_326 currency places 2 currency INR → varchar-exact-decimal + shadow Field_326__n Double
App_33 / Form_131.Field_327 percent places 2 → varchar-exact-decimal + shadow Field_327__n Double
App_33 / Form_131.Field_328 currency places 2 currency INR → varchar-exact-decimal + shadow Field_328__n Double
App_33 / Form_132.Field_329 currency places 2 currency INR → varchar-exact-decimal + shadow Field_329__n Double
App_34 / Form_133.Field_330 decimal places 2 → varchar-exact-decimal + shadow Field_330__n Double
App_34 / Form_134.Field_331 currency places 2 currency INR → varchar-exact-decimal + shadow Field_331__n Double
App_34 / Form_134.Field_332 currency places 2 currency INR → varchar-exact-decimal + shadow Field_332__n Double
App_34 / Form_134.Field_333 currency places 2 currency INR → varchar-exact-decimal + shadow Field_333__n Double
App_34 / Form_135.Field_334 decimal places 2 → varchar-exact-decimal + shadow Field_334__n Double
App_34 / Form_135.Field_335 currency places 2 currency INR → varchar-exact-decimal + shadow Field_335__n Double
App_34 / Form_135.Field_336 currency places 2 currency INR → varchar-exact-decimal + shadow Field_336__n Double
App_34 / Form_136.Field_337 currency places 2 currency INR → varchar-exact-decimal + shadow Field_337__n Double
App_34 / Form_137.Field_338 currency places 2 currency INR → varchar-exact-decimal + shadow Field_338__n Double
App_34 / Form_137.Field_339 currency places 2 currency INR → varchar-exact-decimal + shadow Field_339__n Double
App_34 / Form_137.Field_340 percent places 2 → varchar-exact-decimal + shadow Field_340__n Double
App_35 / Form_138.Field_341 currency places 2 currency INR → varchar-exact-decimal + shadow Field_341__n Double
App_35 / Form_138.Field_342 currency places 2 currency INR → varchar-exact-decimal + shadow Field_342__n Double
App_35 / Form_138.Field_343 currency places 2 currency INR → varchar-exact-decimal + shadow Field_343__n Double
App_35 / Form_138.Field_344 percent places 2 → varchar-exact-decimal + shadow Field_344__n Double
App_35 / Form_138.Field_345 currency places 2 currency INR → varchar-exact-decimal + shadow Field_345__n Double
App_35 / Form_139.Field_346 currency places 2 currency INR → varchar-exact-decimal + shadow Field_346__n Double
App_35 / Form_140.Field_347 currency places 2 currency INR → varchar-exact-decimal + shadow Field_347__n Double
App_35 / Form_140.Field_348 currency places 2 currency INR → varchar-exact-decimal + shadow Field_348__n Double
App_35 / Form_141.Field_349 currency places 2 currency INR → varchar-exact-decimal + shadow Field_349__n Double
App_35 / Form_141.Field_350 currency places 2 currency INR → varchar-exact-decimal + shadow Field_350__n Double
App_35 / Form_141.Field_351 currency places 2 currency INR → varchar-exact-decimal + shadow Field_351__n Double
App_35 / Form_142.Field_352 currency places 2 currency INR → varchar-exact-decimal + shadow Field_352__n Double
App_35 / Form_142.Field_353 currency places 2 currency INR → varchar-exact-decimal + shadow Field_353__n Double
App_35 / Form_143.Field_354 percent places 2 → varchar-exact-decimal + shadow Field_354__n Double
App_35 / Form_143.Field_355 percent places 2 → varchar-exact-decimal + shadow Field_355__n Double
App_35 / Form_143.Field_356 percent places 2 → varchar-exact-decimal + shadow Field_356__n Double
App_36 / Form_144.Field_357 currency places 2 currency INR → varchar-exact-decimal + shadow Field_357__n Double
App_36 / Form_144.Field_358 currency places 2 currency INR → varchar-exact-decimal + shadow Field_358__n Double
App_36 / Form_145.Field_359 currency places 2 currency INR → varchar-exact-decimal + shadow Field_359__n Double
App_36 / Form_145.Field_360 currency places 2 currency INR → varchar-exact-decimal + shadow Field_360__n Double
App_36 / Form_146.Field_361 currency places 2 currency INR → varchar-exact-decimal + shadow Field_361__n Double
App_36 / Form_146.Field_362 currency places 2 currency INR → varchar-exact-decimal + shadow Field_362__n Double
App_36 / Form_146.Field_363 currency places 2 currency INR → varchar-exact-decimal + shadow Field_363__n Double
App_36 / Form_146.Field_364 currency places 2 currency INR → varchar-exact-decimal + shadow Field_364__n Double
App_36 / Form_146.Field_365 currency places 2 currency INR → varchar-exact-decimal + shadow Field_365__n Double
App_36 / Form_146.Field_366 currency places 2 currency INR → varchar-exact-decimal + shadow Field_366__n Double
App_36 / Form_146.Field_367 currency places 2 currency INR → varchar-exact-decimal + shadow Field_367__n Double
App_36 / Form_146.Field_368 currency places 2 currency INR → varchar-exact-decimal + shadow Field_368__n Double
App_36 / Form_146.Field_369 currency places 2 currency INR → varchar-exact-decimal + shadow Field_369__n Double
App_36 / Form_146.Field_370 currency places 2 currency INR → varchar-exact-decimal + shadow Field_370__n Double
App_36 / Form_146.Field_371 currency places 2 currency INR → varchar-exact-decimal + shadow Field_371__n Double
App_36 / Form_146.Field_372 currency places 2 currency INR → varchar-exact-decimal + shadow Field_372__n Double
App_36 / Form_146.Field_373 currency places 2 currency INR → varchar-exact-decimal + shadow Field_373__n Double
App_36 / Form_146.Field_374 currency places 2 currency INR → varchar-exact-decimal + shadow Field_374__n Double
App_36 / Form_146.Field_375 currency places 2 currency INR → varchar-exact-decimal + shadow Field_375__n Double
App_36 / Form_146.Field_376 currency places 2 currency INR → varchar-exact-decimal + shadow Field_376__n Double
App_36 / Form_146.Field_377 currency places 2 currency INR → varchar-exact-decimal + shadow Field_377__n Double
App_36 / Form_146.Field_378 currency places 2 currency INR → varchar-exact-decimal + shadow Field_378__n Double
App_36 / Form_146.Field_379 currency places 2 currency INR → varchar-exact-decimal + shadow Field_379__n Double
App_36 / Form_146.Field_380 currency places 2 currency INR → varchar-exact-decimal + shadow Field_380__n Double
App_36 / Form_146.Field_381 currency places 2 currency INR → varchar-exact-decimal + shadow Field_381__n Double
App_36 / Form_146.Field_382 currency places 2 currency INR → varchar-exact-decimal + shadow Field_382__n Double
App_36 / Form_146.Field_383 currency places 2 currency INR → varchar-exact-decimal + shadow Field_383__n Double
App_36 / Form_146.Field_384 currency places 2 currency INR → varchar-exact-decimal + shadow Field_384__n Double
App_36 / Form_146.Field_385 currency places 2 currency INR → varchar-exact-decimal + shadow Field_385__n Double
App_36 / Form_146.Field_386 currency places 2 currency INR → varchar-exact-decimal + shadow Field_386__n Double
App_36 / Form_146.Field_387 currency places 2 currency INR → varchar-exact-decimal + shadow Field_387__n Double
App_36 / Form_146.Field_388 currency places 2 currency INR → varchar-exact-decimal + shadow Field_388__n Double
App_36 / Form_146.Field_389 currency places 2 currency INR → varchar-exact-decimal + shadow Field_389__n Double
App_36 / Form_146.Field_390 currency places 2 currency INR → varchar-exact-decimal + shadow Field_390__n Double
App_36 / Form_146.Field_391 currency places 2 currency INR → varchar-exact-decimal + shadow Field_391__n Double
App_36 / Form_146.Field_392 currency places 2 currency INR → varchar-exact-decimal + shadow Field_392__n Double
App_36 / Form_146.Field_393 currency places 2 currency INR → varchar-exact-decimal + shadow Field_393__n Double
App_36 / Form_146.Field_394 currency places 2 currency INR → varchar-exact-decimal + shadow Field_394__n Double
App_36 / Form_146.Field_395 currency places 2 currency INR → varchar-exact-decimal + shadow Field_395__n Double
App_36 / Form_146.Field_396 currency places 2 currency INR → varchar-exact-decimal + shadow Field_396__n Double
App_36 / Form_146.Field_397 currency places 2 currency INR → varchar-exact-decimal + shadow Field_397__n Double
App_36 / Form_146.Field_398 currency places 2 currency INR → varchar-exact-decimal + shadow Field_398__n Double
App_36 / Form_146.Field_399 currency places 2 currency INR → varchar-exact-decimal + shadow Field_399__n Double
App_36 / Form_146.Field_400 currency places 2 currency INR → varchar-exact-decimal + shadow Field_400__n Double
App_36 / Form_146.Field_401 currency places 2 currency INR → varchar-exact-decimal + shadow Field_401__n Double
App_36 / Form_146.Field_402 currency places 2 currency INR → varchar-exact-decimal + shadow Field_402__n Double
App_36 / Form_146.Field_403 currency places 2 currency INR → varchar-exact-decimal + shadow Field_403__n Double
App_36 / Form_146.Field_404 currency places 2 currency INR → varchar-exact-decimal + shadow Field_404__n Double
App_36 / Form_146.Field_405 currency places 2 currency INR → varchar-exact-decimal + shadow Field_405__n Double
App_36 / Form_146.Field_406 currency places 2 currency INR → varchar-exact-decimal + shadow Field_406__n Double
App_36 / Form_146.Field_407 currency places 2 currency INR → varchar-exact-decimal + shadow Field_407__n Double
App_36 / Form_146.Field_408 currency places 2 currency INR → varchar-exact-decimal + shadow Field_408__n Double
App_36 / Form_147.Field_409 currency places 2 currency INR → varchar-exact-decimal + shadow Field_409__n Double
App_36 / Form_147.Field_410 currency places 2 currency INR → varchar-exact-decimal + shadow Field_410__n Double
App_36 / Form_148.Field_411 currency places 2 currency INR → varchar-exact-decimal + shadow Field_411__n Double
App_36 / Form_148.Field_412 percent places 2 → varchar-exact-decimal + shadow Field_412__n Double
App_36 / Form_148.Field_413 percent places 2 → varchar-exact-decimal + shadow Field_413__n Double
App_36 / Form_148.Field_414 currency places 2 currency INR → varchar-exact-decimal + shadow Field_414__n Double
App_36 / Form_149.Field_415 currency places 2 currency INR → varchar-exact-decimal + shadow Field_415__n Double
App_36 / Form_150.Field_416 currency places 2 currency INR → varchar-exact-decimal + shadow Field_416__n Double
App_36 / Form_150.Field_417 currency places 2 currency INR → varchar-exact-decimal + shadow Field_417__n Double
App_36 / Form_150.Field_418 currency places 2 currency INR → varchar-exact-decimal + shadow Field_418__n Double
App_37 / Form_151.Field_419 currency places 2 currency USD → varchar-exact-decimal + shadow Field_419__n Double
App_37 / Form_151.Field_420 currency places 2 currency USD → varchar-exact-decimal + shadow Field_420__n Double
App_37 / Form_151.Field_421 percent places 2 → varchar-exact-decimal + shadow Field_421__n Double
App_37 / Form_151.Field_422 currency places 2 currency USD → varchar-exact-decimal + shadow Field_422__n Double
App_37 / Form_151.Field_423 currency places 2 currency USD → varchar-exact-decimal + shadow Field_423__n Double
App_37 / Form_151.Field_424 currency places 2 currency USD → varchar-exact-decimal + shadow Field_424__n Double
App_37 / Form_151.Field_425 currency places 2 currency USD → varchar-exact-decimal + shadow Field_425__n Double
App_37 / Form_152.Field_426 currency places 2 currency USD → varchar-exact-decimal + shadow Field_426__n Double
App_37 / Form_153.Field_427 currency places 2 currency USD → varchar-exact-decimal + shadow Field_427__n Double
App_37 / Form_154.Field_428 currency places 2 currency USD → varchar-exact-decimal + shadow Field_428__n Double
App_37 / Form_154.Field_429 currency places 2 currency USD → varchar-exact-decimal + shadow Field_429__n Double
App_38 / Form_155.Field_430 decimal places 2 → varchar-exact-decimal + shadow Field_430__n Double
App_38 / Form_155.Field_431 decimal places 2 → varchar-exact-decimal + shadow Field_431__n Double
App_38 / Form_155.Field_432 decimal places 2 → varchar-exact-decimal + shadow Field_432__n Double
App_38 / Form_155.Field_433 decimal places 2 → varchar-exact-decimal + shadow Field_433__n Double
App_38 / Form_156.Field_434 currency places 2 currency INR → varchar-exact-decimal + shadow Field_434__n Double
App_38 / Form_157.Field_435 currency places 2 currency INR → varchar-exact-decimal + shadow Field_435__n Double
App_39 / Form_158.Field_436 currency places 2 currency INR → varchar-exact-decimal + shadow Field_436__n Double
App_39 / Form_159.Field_437 currency places 2 currency INR → varchar-exact-decimal + shadow Field_437__n Double
App_39 / Form_160.Field_438 decimal places 2 → varchar-exact-decimal + shadow Field_438__n Double
App_40 / Form_161.Field_439 decimal places 2 → varchar-exact-decimal + shadow Field_439__n Double
App_40 / Form_162.Field_440 decimal places 2 → varchar-exact-decimal + shadow Field_440__n Double
