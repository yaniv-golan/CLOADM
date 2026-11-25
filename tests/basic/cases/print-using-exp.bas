# follow-up of bb1 print-using: E notation's sign place, fields with one # or none before the point, signs, zero, long fields [UM]
PRINT USING "#.##^^^^";1234;-1234
PRINT USING ".##^^^^";1234;-1234
PRINT USING "+##.##^^^^";12345;-12345
PRINT USING "##.##^^^^-";12345;-12345
PRINT USING "##.##^^^^";-12345;0
PRINT USING "###^^^^";5
PRINT USING "##########^^^^";1
PRINT USING "###########^^^^";1
