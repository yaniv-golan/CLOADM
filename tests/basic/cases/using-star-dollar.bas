# bb-only: PRINT USING's ** and $$ fields with a number (docs/clean-room-basic.md section 2, PRINT USING): ** with $,
# with a negative number, ** alone, $$, and ** with $ and two places. Ours prints **$42, *-$42, **42, " $42" and
# **$42.00, and for a trailing + with -5, " 5-", ##^^^ with 1.5, " 2^^^", and a one-place format A$ just below
# B$ "#" in the string space, "%55"; the original's answers are wanted (a review found no record holds these). Syntax [UM]; the answers [BB].
#timeout 20
PRINT USING "**$##";42
PRINT USING "**$##";-42
PRINT USING "**##";42
PRINT USING "$$##";42
PRINT USING "**$##.##";42
PRINT USING "##+";-5
PRINT USING "##^^^";1.5
10 B$="#"+"":A$="#"+"":PRINT USING A$;55
RUN
