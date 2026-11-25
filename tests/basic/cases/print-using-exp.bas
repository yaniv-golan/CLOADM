# follow-up of bb1 print-using: E notation's sign place, fields with one # or none before the point, signs, zero, long fields; ten and eleven #s (ten digit places) with several values, a sign of its own and a point [UM]
PRINT USING "#.##^^^^";1234;-1234
PRINT USING ".##^^^^";1234;-1234
PRINT USING "+##.##^^^^";12345;-12345
PRINT USING "##.##^^^^-";12345;-12345
PRINT USING "##.##^^^^";-12345;0
PRINT USING "###^^^^";5
PRINT USING "##########^^^^";1
PRINT USING "###########^^^^";1
PRINT USING "##########^^^^";12345;-1;.5;1E10
PRINT USING "###########^^^^";12345;-1;.5;1E10
PRINT USING "+##########^^^^";-1
PRINT USING "#######.####^^^^";12345
PRINT USING "############^^^^";1
