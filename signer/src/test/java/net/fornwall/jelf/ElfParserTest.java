package net.fornwall.jelf;
import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class ElfParserTest {
    @Test public void swapsAllEightBytesWithoutSignExtension() {
        ElfParser parser = new ElfParser(null, null);
        assertEquals(0x3d329573d9adfa95L, parser.byteSwap(0x95faadd97395323dL));
        assertEquals(0x8000000000000000L, parser.byteSwap(0x80L));
        assertEquals(0L, parser.byteSwap(0L));
    }
}
