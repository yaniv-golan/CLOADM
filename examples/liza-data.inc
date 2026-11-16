; ---------------------------------------------------------------
; LIZA conversation data, shared by the 6809 build (examples/liza.asm)
; and the 6803 build (examples/liza6803.asm). One copy of the words, so
; the two programs hold the same conversations.
;
; Pulled in with INCLUDE "liza-data.inc" where the code wants it, so the
; tables sit at the same place in both memory images: a pointer stored in
; an FDB is an address, which differs between the two builds.
; ---------------------------------------------------------------

; keyword table: text, response list. Earlier entries win.
KEYTAB  FCB     " COMPUTER",0
        FDB     R_COMP
        FCB     " DRAGON",0
        FDB     R_COMP
        FCB     " I NEED ",0
        FDB     R_NEED
        FCB     " I AM ",0
        FDB     R_IAM
        FCB     " I'M ",0
        FDB     R_IAM
        FCB     " I FEEL ",0
        FDB     R_FEEL
        FCB     " I WANT ",0
        FDB     R_WANT
        FCB     " I THINK ",0
        FDB     R_THINK
        FCB     " I CAN'T ",0
        FDB     R_CANT
        FCB     " BECAUSE ",0
        FDB     R_BEC
        FCB     " SORRY ",0
        FDB     R_SORRY
        FCB     " MOTHER",0
        FDB     R_FAM
        FCB     " FATHER",0
        FDB     R_FAM
        FCB     " FAMILY",0
        FDB     R_FAM
        FCB     " DREAM",0
        FDB     R_DREAM
        FCB     " FRIEND",0
        FDB     R_FRIEND
        FCB     " ALWAYS ",0
        FDB     R_ALWAYS
        FCB     " WHY DON'T YOU ",0
        FDB     R_WDY
        FCB     " CAN YOU ",0
        FDB     R_CANYOU
        FCB     " YOU ARE ",0
        FDB     R_YOUARE
        FCB     " YOU'RE ",0
        FDB     R_YOUARE
        FCB     " HELLO ",0
        FDB     R_HELLO
        FCB     " HI ",0
        FDB     R_HELLO
        FCB     " YES ",0
        FDB     R_YES
        FCB     " NO ",0
        FDB     R_NO
        FCB     " MY ",0
        FDB     R_MY
        FCB     " YOU ",0
        FDB     R_YOU
        FCB     0

; word swaps used when echoing the user's words back
RTAB    FCB     "I",0,"YOU",0
        FCB     "ME",0,"YOU",0
        FCB     "MY",0,"YOUR",0
        FCB     "MYSELF",0,"YOURSELF",0
        FCB     "AM",0,"ARE",0
        FCB     "WAS",0,"WERE",0
        FCB     "I'M",0,"YOU'RE",0
        FCB     "I'VE",0,"YOU'VE",0
        FCB     "I'LL",0,"YOU'LL",0
        FCB     "MINE",0,"YOURS",0
        FCB     "YOU",0,"I",0
        FCB     "YOUR",0,"MY",0
        FCB     "YOURS",0,"MINE",0
        FCB     "YOU'RE",0,"I'M",0
        FCB     "ARE",0,"AM",0
        FCB     0

; response lists: count, next index, pointers. '*' = user's words
R_NEED  FCB     3,0
        FDB     N_1,N_2,N_3
N_1     FCB     "WHY DO YOU NEED*?",0
N_2     FCB     "WOULD IT REALLY HELP YOU TO GET*?",0
N_3     FCB     "ARE YOU SURE YOU NEED*?",0

R_IAM   FCB     3,0
        FDB     A_1,A_2,A_3
A_1     FCB     "HOW LONG HAVE YOU BEEN*?",0
A_2     FCB     "DID YOU COME TO ME BECAUSE YOU ARE*?",0
A_3     FCB     "HOW DO YOU FEEL ABOUT BEING*?",0

R_FEEL  FCB     3,0
        FDB     F_1,F_2,F_3
F_1     FCB     "TELL ME MORE ABOUT FEELING*.",0
F_2     FCB     "DO YOU OFTEN FEEL*?",0
F_3     FCB     "WHEN DID YOU FIRST FEEL*?",0

R_WANT  FCB     3,0
        FDB     W_1,W_2,W_3
W_1     FCB     "WHAT WOULD IT MEAN TO YOU IF YOU GOT*?",0
W_2     FCB     "WHY DO YOU WANT*?",0
W_3     FCB     "WHAT WOULD CHANGE IF YOU HAD*?",0

R_THINK FCB     3,0
        FDB     T_1,T_2,T_3
T_1     FCB     "DO YOU REALLY THINK*?",0
T_2     FCB     "WHAT MAKES YOU THINK*?",0
T_3     FCB     "BUT YOU ARE NOT SURE*?",0

R_CANT  FCB     3,0
        FDB     C_1,C_2,C_3
C_1     FCB     "WHAT MAKES YOU THINK YOU CAN'T*?",0
C_2     FCB     "HAVE YOU REALLY TRIED?",0
C_3     FCB     "PERHAPS YOU COULD* IF YOU TRIED.",0

R_BEC   FCB     3,0
        FDB     B_1,B_2,B_3
B_1     FCB     "IS THAT THE REAL REASON?",0
B_2     FCB     "WHAT OTHER REASONS COME TO MIND?",0
B_3     FCB     "DOES THAT REASON EXPLAIN ANYTHING ELSE?",0

R_SORRY FCB     2,0
        FDB     S_1,S_2
S_1     FCB     "THERE IS NO NEED TO APOLOGISE.",0
S_2     FCB     "WHAT DO YOU FEEL WHEN YOU APOLOGISE?",0

R_FAM   FCB     3,0
        FDB     FA_1,FA_2,FA_3
FA_1    FCB     "TELL ME MORE ABOUT YOUR FAMILY.",0
FA_2    FCB     "HOW DO YOU GET ALONG WITH YOUR FAMILY?",0
FA_3    FCB     "DOES YOUR FAMILY OFTEN COME TO MIND?",0

R_DREAM FCB     3,0
        FDB     D_1,D_2,D_3
D_1     FCB     "WHAT DOES THAT DREAM SUGGEST TO YOU?",0
D_2     FCB     "DO YOU DREAM OFTEN?",0
D_3     FCB     "DO YOU BELIEVE DREAMS MEAN SOMETHING?",0

R_FRIEND FCB    2,0
        FDB     FR_1,FR_2
FR_1    FCB     "TELL ME ABOUT YOUR FRIENDS.",0
FR_2    FCB     "WHY DO YOU BRING UP FRIENDS?",0

R_COMP  FCB     3,0
        FDB     CO_1,CO_2,CO_3
CO_1    FCB     "DO COMPUTERS WORRY YOU?",0
CO_2    FCB     "I AM ONLY A DRAGON 64 WITH 64K OF MEMORY. WHAT DID YOU EXPECT?",0
CO_3    FCB     "WHY DO YOU MENTION COMPUTERS?",0

R_ALWAYS FCB    2,0
        FDB     AL_1,AL_2
AL_1    FCB     "CAN YOU THINK OF A SPECIFIC EXAMPLE?",0
AL_2    FCB     "REALLY, ALWAYS?",0

R_WDY   FCB     2,0
        FDB     WD_1,WD_2
WD_1    FCB     "DO YOU REALLY BELIEVE I DON'T*?",0
WD_2    FCB     "PERHAPS ONE DAY I WILL*.",0

R_CANYOU FCB    2,0
        FDB     CY_1,CY_2
CY_1    FCB     "WHY DO YOU THINK I CAN*?",0
CY_2    FCB     "WHAT IF I COULD*?",0

R_YOUARE FCB    2,0
        FDB     YA_1,YA_2
YA_1    FCB     "WHY DO YOU SAY I AM*?",0
YA_2    FCB     "DOES IT PLEASE YOU TO THINK I AM*?",0

R_HELLO FCB     2,0
        FDB     H_1,H_2
H_1     FCB     "HELLO. WHAT WOULD YOU LIKE TO TALK ABOUT?",0
H_2     FCB     "HI THERE. HOW ARE YOU FEELING TODAY?",0

R_YES   FCB     2,0
        FDB     Y_1,Y_2
Y_1     FCB     "YOU SEEM QUITE SURE.",0
Y_2     FCB     "I SEE. PLEASE GO ON.",0

R_NO    FCB     2,0
        FDB     NO_1,NO_2
NO_1    FCB     "WHY NOT?",0
NO_2    FCB     "YOU SOUND RATHER NEGATIVE.",0

R_MY    FCB     3,0
        FDB     M_1,M_2,M_3
M_1     FCB     "WHY DO YOU SAY YOUR*?",0
M_2     FCB     "YOUR*?",0
M_3     FCB     "IS IT IMPORTANT TO YOU THAT YOUR*?",0

R_YOU   FCB     2,0
        FDB     U_1,U_2
U_1     FCB     "WE WERE TALKING ABOUT YOU, NOT ME.",0
U_2     FCB     "WHY ARE YOU CONCERNED ABOUT ME?",0

R_NONE  FCB     5,0
        FDB     X_1,X_2,X_3,X_4,X_5
X_1     FCB     "PLEASE TELL ME MORE.",0
X_2     FCB     "I SEE. GO ON.",0
X_3     FCB     "HOW DOES THAT MAKE YOU FEEL?",0
X_4     FCB     "WHAT DOES THAT SUGGEST TO YOU?",0
X_5     FCB     "INTERESTING. PLEASE CONTINUE.",0

R_EMPTY FCB     1,0
        FDB     E_1
E_1     FCB     "YOU ARE VERY QUIET. WHAT IS ON YOUR MIND?",0

R_REP   FCB     1,0
        FDB     RP_1
RP_1    FCB     "YOU JUST SAID THAT. PLEASE DON'T REPEAT YOURSELF.",0


