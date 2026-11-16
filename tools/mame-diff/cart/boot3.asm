* boot3.asm: boot.asm for the CoCo 3, in place of coco3.rom (32K at $8000, vectors at $FFF2). At reset the GIME shows
* the cartridge at $C000-$FEFF (16K internal, 16K external) with the spare chip select ($FF40-$FF5F) off (INIT0
* bit 2 clear). A write there must not reach the cartridge (a banked cartridge stays in bank 0, so the reads of
* $C000 and $FF40 show bank 0 and $00); then this enables it and starts the cartridge at $C000 as boot.asm does.
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        LDA     #$01
        STA     $FF40           ; SCS off: ignored
        LDA     $C000
        LDA     $FF40
        LDA     #$04            ; INIT0: SCS on
        STA     $FF90
        JMP     $C000
        ORG     $BFF0
        FCB     3               ; head.asm MACH: a CoCo 3
        ORG     $FFF2
        FDB     $C009,$C009,$C006,$C009,$C009,$C003,RESET
